// @vitest-environment node
/**
 * A desktop SOAP send through the engine's `openExchange` (`sendThroughEngine`): it records a fixed
 * History row and answers a fixed summary, for a saved request with the editor's envelope over it
 * and for an ad-hoc send or resend; a failed send's row carries the redacted headers and leaves the send's own error;
 * a prepare failure writes a row and no History; a reference nothing resolves is refused.
 */
import { createServer, type IncomingMessage, type Server } from 'node:http';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInterface,
  createProject,
  createRequest,
  DEFAULT_PREFERENCES,
  normalizeWsa,
  WirebenchError,
} from '@wirebench/engine';
import type { HeaderEntry, Project, PropertyScopes, SoapRequestDef, WsdlImportResult } from '@wirebench/engine';
import { HistoryService, type RecordSendInput } from '../src/main/history-service.js';
import { soapOverrideOf } from '../src/main/send/draft.js';
import { previewSoap, sendThroughEngine, type SendThroughEngineDeps } from '../src/main/send/exchange.js';
import { AD_HOC_NAME } from '../src/main/send/record.js';
import type { FailedExchangeWire, HistoryEntryWire, ResolvedSendInputWire } from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

const { cacheReads } = vi.hoisted(() => ({ cacheReads: [] as string[] }));

// Every read of an interface's definition cache by the engine, which finds none here.
vi.mock('../../../packages/engine/src/wsdl/cache.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../../../packages/engine/src/wsdl/cache.js')>()),
  readDefinitionCache: (dir: string) => {
    cacheReads.push(dir);
    return Promise.reject(new Error('no cache here'));
  },
}));

interface EchoServer {
  readonly url: string;
  readonly bodies: string[];
  close(): Promise<void>;
}

async function startEchoServer(): Promise<EchoServer> {
  const bodies: string[] = [];
  async function readBody(req: IncomingMessage): Promise<Buffer> {
    const chunks: Buffer[] = [];
    for await (const chunk of req) chunks.push(chunk as Buffer);
    return Buffer.concat(chunks);
  }
  const server: Server = createServer((req, res) => {
    void (async () => {
      const body = await readBody(req);
      bodies.push(body.toString('utf8'));
      res.writeHead(200, { 'content-type': req.headers['content-type'] ?? 'text/xml' });
      res.end(body);
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  const port = typeof address === 'object' && address !== null ? address.port : 0;
  return {
    url: `http://127.0.0.1:${String(port)}`,
    bodies,
    close: () => new Promise<void>((resolve, reject) => server.close((err) => (err ? reject(err) : resolve()))),
  };
}

const ENVELOPE = '<soap:Envelope><soap:Body><who>${#Project#who}</who></soap:Body></soap:Envelope>';

/** One interface holding `req-1`, its saved endpoint `endpointUrl`. */
function seeded(endpointUrl: string, extra: Partial<SoapRequestDef> = {}): Project {
  const request: SoapRequestDef = {
    ...createRequest('Add', {
      id: 'req-1',
      envelopeXml: ENVELOPE,
      soapVersion: '1.1',
      soapAction: 'urn:calc:Add',
      headers: [{ name: 'X-Trace', value: 'abc' }],
    }),
    endpointUrl,
    ...extra,
  };
  const iface = createInterface('Calculator', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/calc?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Add', bindingName: '{urn:calc}B', slug: 'add', order: 0, requests: [request] }],
  });
  return { ...createProject('Demo', { id: 'p1' }), properties: { who: 'ada' }, interfaces: [iface] };
}

const META = { requestName: 'Add', interfaceName: 'Calculator', operationName: 'Add' };

/** The renderer's input for `req-1`: what the editor holds, sent as `request.send`'s payload. */
function editorInput(
  endpoint: string,
  envelopeXml = ENVELOPE,
  headers: HeaderEntry[] = [{ name: 'X-Trace', value: 'abc' }],
) {
  return {
    endpoint,
    envelopeXml,
    soapVersion: '1.1' as const,
    soapAction: 'urn:calc:Add',
    headers: Object.fromEntries(headers.map((header) => [header.name, header.value])),
  };
}

let server: EchoServer;
let userDataDir: string;

beforeAll(async () => {
  server = await startEchoServer();
});

afterAll(async () => {
  await server.close();
});

beforeEach(async () => {
  userDataDir = await mkdtemp(join(tmpdir(), 'wirebench-send-exchange-soap-'));
});

afterEach(async () => {
  await rm(userDataDir, { recursive: true, force: true });
});

async function openHistory(): Promise<HistoryService> {
  const history = new HistoryService(userDataDir);
  await history.open('p1');
  return history;
}

function depsFor(model: Project, extra: Parameters<typeof sendDepsFor>[1] = {}): SendThroughEngineDeps {
  return sendDepsFor(model, {
    preferences: () => DEFAULT_PREFERENCES,
    ...extra,
    project: { requestMeta: () => META, ...extra.project },
  });
}

const volatile = new Set(['id', 'sendId', 'at', 'startedAt', 'durationMs', 'timings', 'date', 'totalMs']);
const steady = (head: string): string => head.replace(/date: [^\r\n]*/gi, 'date: -');
const normalise = (value: unknown): unknown =>
  value === undefined
    ? undefined
    : JSON.parse(
        JSON.stringify(value, (key, inner: unknown) => {
          if (volatile.has(key) || (Array.isArray(inner) && volatile.has(String(inner[0]).toLowerCase()))) {
            return undefined;
          }
          if (typeof inner === 'string' && key.endsWith('Base64')) {
            return steady(Buffer.from(inner, 'base64').toString('latin1'));
          }
          return typeof inner === 'string' ? steady(inner) : inner;
        }),
      );

describe('sendThroughEngine for a SOAP request', () => {
  /** The response rows the echo server answers with, `date` dropped by {@link normalise}. */
  const echoRawHeaders = [
    ['content-type', 'text/xml;charset=UTF-8'],
    null,
    ['connection', 'keep-alive'],
    ['keep-alive', 'timeout=5'],
    ['transfer-encoding', 'chunked'],
  ];
  const sentHeaders = [
    { name: 'X-Trace', value: 'abc' },
    { name: 'User-Agent', value: 'Wirebench/0.1' },
    { name: 'Accept-Encoding', value: 'gzip, deflate' },
  ];

  it('records the editor envelope as typed in History and answers the summary of what went out', async () => {
    const model = seeded('http://127.0.0.1:1/never');
    const draftEnvelope = '<soap:Envelope><soap:Body>${#Project#who} draft</soap:Body></soap:Envelope>';
    const sentEnvelope = '<soap:Envelope><soap:Body>ada draft</soap:Body></soap:Envelope>';
    const editor = editorInput(`${server.url}/calc`, draftEnvelope);
    const appended: HistoryEntryWire[] = [];
    const after = await sendThroughEngine(
      depsFor(model, { history: await openHistory(), onHistoryAppended: (wire) => appended.push(wire) }),
      's1',
      'req-1',
      { draft: { kind: 'soap', override: soapOverrideOf(editor) } },
    );
    expect(server.bodies.at(-1)).toContain('ada draft');
    expect(normalise(appended[0])).toEqual({
      kind: 'soap',
      projectId: 'p1',
      requestId: 'req-1',
      requestName: 'Add',
      interfaceName: 'Calculator',
      operationName: 'Add',
      endpoint: `${server.url}/calc`,
      soapVersion: '1.1',
      soapAction: 'urn:calc:Add',
      status: 200,
      ok: true,
      request: { envelopeXml: draftEnvelope, headers: sentHeaders },
      response: { envelopeXml: sentEnvelope, rawHeaders: echoRawHeaders, status: 200, statusText: 'OK' },
      sizeBytes: 232,
    });
    const host = server.url.replace('http://', '');
    // The whole summary, as the app's own SOAP path answered it.
    expect(normalise(after)).toEqual({
      http: {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'text/xml;charset=UTF-8',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
        rawHeaders: [
          ['content-type', 'text/xml;charset=UTF-8'],
          null,
          ['connection', 'keep-alive'],
          ['keep-alive', 'timeout=5'],
          ['transfer-encoding', 'chunked'],
        ],
        bodyBase64: '<soap:Envelope><soap:Body>ada draft</soap:Body></soap:Envelope>',
        rawBodyBase64: '<soap:Envelope><soap:Body>ada draft</soap:Body></soap:Envelope>',
        rawRequestBase64:
          'POST /calc HTTP/1.1\r\nhost: ' +
          host +
          '\r\ncontent-type: text/xml;charset=UTF-8\r\nSOAPAction: "urn:calc:Add"\r\nX-Trace: abc\r\nUser-Agent: Wirebench/0.1\r\nAccept-Encoding: gzip, deflate\r\ncontent-length: 63\r\n\r\n<soap:Envelope><soap:Body>ada draft</soap:Body></soap:Envelope>',
        rawResponseBase64:
          'HTTP/1.1 200 OK\r\ncontent-type: text/xml;charset=UTF-8\r\ndate: -\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\ntransfer-encoding: chunked\r\n\r\n<soap:Envelope><soap:Body>ada draft</soap:Body></soap:Envelope>',
        truncated: false,
        httpVersion: '1.1',
        redirects: [],
        request: {
          url: 'http://' + host + '/calc',
          method: 'POST',
          headers: {
            'content-type': 'text/xml;charset=UTF-8',
            SOAPAction: '"urn:calc:Add"',
            'X-Trace': 'abc',
            'User-Agent': 'Wirebench/0.1',
            'Accept-Encoding': 'gzip, deflate',
          },
        },
      },
      response: {
        envelopeXml: '<soap:Envelope><soap:Body>ada draft</soap:Body></soap:Envelope>',
        isSoap: false,
        attachments: [],
      },
      problems: [
        {
          code: 'xml-parse-error',
          message: 'Error constructing the DOM: NamespaceError: prefix is non-null and namespace is null',
        },
      ],
      unresolved: [],
    });
  });

  it('records an ad-hoc resend under its project and an ad-hoc send nowhere', async () => {
    const model = seeded('http://127.0.0.1:1/never');
    const scopes: PropertyScopes = { project: {}, global: { g: 'globe' }, system: process.env };
    const input: ResolvedSendInputWire = {
      endpoint: `${server.url}/adhoc`,
      envelopeXml: '<Envelope>${#Global#g}</Envelope>',
      soapVersion: '1.1',
      // As a resend's recorded headers carry them: the preferences' own headers were applied when it was sent.
      headers: { 'X-Trace': 'abc', 'User-Agent': 'Wirebench/0.1', 'Accept-Encoding': 'gzip, deflate' },
    };
    const resend = { ...META, requestName: 'Gone', projectId: 'p1' };
    const host = server.url.replace('http://', '');
    const adHocSummary = {
      http: {
        status: 200,
        statusText: 'OK',
        headers: {
          'content-type': 'text/xml;charset=UTF-8',
          connection: 'keep-alive',
          'keep-alive': 'timeout=5',
          'transfer-encoding': 'chunked',
        },
        rawHeaders: [
          ['content-type', 'text/xml;charset=UTF-8'],
          null,
          ['connection', 'keep-alive'],
          ['keep-alive', 'timeout=5'],
          ['transfer-encoding', 'chunked'],
        ],
        bodyBase64: '<Envelope>globe</Envelope>',
        rawBodyBase64: '<Envelope>globe</Envelope>',
        rawRequestBase64:
          'POST /adhoc HTTP/1.1\r\nhost: ' +
          host +
          '\r\ncontent-type: text/xml;charset=UTF-8\r\nSOAPAction: ""\r\nX-Trace: abc\r\nUser-Agent: Wirebench/0.1\r\nAccept-Encoding: gzip, deflate\r\ncontent-length: 26\r\n\r\n<Envelope>globe</Envelope>',
        rawResponseBase64:
          'HTTP/1.1 200 OK\r\ncontent-type: text/xml;charset=UTF-8\r\ndate: -\r\nconnection: keep-alive\r\nkeep-alive: timeout=5\r\ntransfer-encoding: chunked\r\n\r\n<Envelope>globe</Envelope>',
        truncated: false,
        httpVersion: '1.1',
        redirects: [],
        request: {
          url: 'http://' + host + '/adhoc',
          method: 'POST',
          headers: {
            'content-type': 'text/xml;charset=UTF-8',
            SOAPAction: '""',
            'X-Trace': 'abc',
            'User-Agent': 'Wirebench/0.1',
            'Accept-Encoding': 'gzip, deflate',
          },
        },
      },
      response: {
        envelopeXml: '<Envelope>globe</Envelope>',
        isSoap: false,
        attachments: [],
      },
      problems: [
        {
          code: 'not-soap',
          message: 'Response is not a SOAP Envelope',
        },
      ],
      unresolved: [],
    };
    const rows: (HistoryEntryWire | undefined)[] = [];
    for (const names of [AD_HOC_NAME, resend]) {
      const appended: HistoryEntryWire[] = [];
      const after = await sendThroughEngine(
        depsFor(model, {
          history: await openHistory(),
          onHistoryAppended: (wire) => appended.push(wire),
          adHocScopes: () => scopes,
        }),
        's1',
        'ad-hoc',
        { draft: { kind: 'soap' }, adHoc: { input, names } },
      );
      expect(server.bodies.at(-1)).toBe('<Envelope>globe</Envelope>');
      expect(after.http.request.url).toBe(`${server.url}/adhoc`);
      // The whole summary, as the app's own SOAP path answered it, for the send and the resend alike.
      expect(normalise(after)).toEqual(adHocSummary);
      rows.push(appended[0]);
    }
    // A plain ad-hoc send names no project, so nothing was recorded; the resend went back into p1.
    expect(rows[0]).toBeUndefined();
    expect(normalise(rows[1])).toEqual({
      kind: 'soap',
      projectId: 'p1',
      requestName: 'Gone',
      interfaceName: 'Calculator',
      operationName: 'Add',
      endpoint: `${server.url}/adhoc`,
      soapVersion: '1.1',
      status: 200,
      ok: true,
      request: { envelopeXml: '<Envelope>${#Global#g}</Envelope>', headers: sentHeaders },
      response: {
        envelopeXml: '<Envelope>globe</Envelope>',
        rawHeaders: echoRawHeaders,
        status: 200,
        statusText: 'OK',
      },
      sizeBytes: 195,
    });
    const history = await openHistory();
    expect(history.list().entries.map((entry) => entry.requestName)).toEqual(['Gone']);
  });

  it('sends an orphaned request, which a run skips', async () => {
    const model = seeded(`${server.url}/calc`, { orphaned: true });
    const summary = await sendThroughEngine(depsFor(model), 's1', 'req-1', { draft: { kind: 'soap' } });
    expect(summary.http.status).toBe(200);
    expect(server.bodies.at(-1)).toContain('<who>ada</who>');
  });

  it('refuses a reference nothing resolves as unresolved-properties, writing no History entry', async () => {
    const model = seeded(`${server.url}/calc`);
    const appended: HistoryEntryWire[] = [];
    const recordSend = vi.fn();
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const before = server.bodies.length;
    await expect(
      sendThroughEngine(
        depsFor(model, {
          history: { recordSend } as never,
          onHistoryAppended: (wire) => appended.push(wire),
          onSendFailed,
        }),
        's1',
        'req-1',
        { draft: { kind: 'soap', override: soapOverrideOf(editorInput(`${server.url}/calc`, '<a>${nope}</a>')) } },
      ),
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
    expect(recordSend).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(server.bodies.length).toBe(before);
    // Refused before the wire: the HTTP Log gets a prepare row, with no headers.
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({
      protocol: 'soap',
      requestId: 'req-1',
      stage: 'prepare',
      request: { url: `${server.url}/calc`, method: 'POST', headers: {} },
      error: { code: 'unresolved-properties' },
    });
  });

  it("puts the operation's default wsa:Action, from the app's loaded definition, on the wire when the interface does not cache it", async () => {
    const base = seeded(`${server.url}/wsa`, {
      envelopeXml:
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header/><soap:Body/></soap:Envelope>',
    });
    // No SOAPAction: the default action is the only one WS-Addressing can add.
    const request = Object.fromEntries(
      Object.entries(base.interfaces[0]!.operations[0]!.requests[0]!).filter(([key]) => key !== 'soapAction'),
    ) as unknown as SoapRequestDef;
    const iface = {
      ...base.interfaces[0]!,
      cacheDefinition: false,
      wsa: normalizeWsa({ enabled: true, version: '2005/08' }),
      operations: [{ ...base.interfaces[0]!.operations[0]!, requests: [request] }],
    };
    const model: Project = { ...base, interfaces: [iface] };
    const defaultWsaActionFor = vi.fn((requestId: string) => (requestId === 'req-1' ? 'urn:calc:AddDefault' : ''));
    await sendThroughEngine(depsFor(model, { project: { defaultWsaActionFor } }), 's1', 'req-1', {
      draft: { kind: 'soap' },
    });
    expect(defaultWsaActionFor).toHaveBeenCalledWith('req-1');
    expect(server.bodies.at(-1)).toMatch(/<wsa:Action[^>]*>urn:calc:AddDefault<\/wsa:Action>/);
  });

  it("sends an ad-hoc input's own WS-Addressing, with its default action", async () => {
    const input: ResolvedSendInputWire = {
      endpoint: `${server.url}/adhoc-wsa`,
      envelopeXml:
        '<soap:Envelope xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/"><soap:Header/><soap:Body/></soap:Envelope>',
      soapVersion: '1.1',
      wsa: { config: { enabled: true, version: '2005/08' }, defaultAction: 'urn:adhoc:Act' },
    };
    await sendThroughEngine(depsFor(seeded(server.url)), 's1', 'ad-hoc', {
      draft: { kind: 'soap' },
      adHoc: { input, names: AD_HOC_NAME },
    });
    expect(server.bodies.at(-1)).toMatch(/<wsa:Action[^>]*>urn:adhoc:Act<\/wsa:Action>/);
  });

  it('refuses a request no project holds as unknown-entity', async () => {
    await expect(
      sendThroughEngine(depsFor(seeded(server.url)), 's1', 'nope', { draft: { kind: 'soap' } }),
    ).rejects.toMatchObject({ code: 'unknown-entity', message: 'No SOAP request with id "nope"' });
  });
});

describe('sendThroughEngine (SOAP) → onSendFailed', () => {
  const failing = (extra: Partial<SoapRequestDef> = {}) =>
    seeded('http://127.0.0.1:1/nope', {
      envelopeXml: '<Envelope/>',
      properties: { ...createRequest('x', { envelopeXml: '', soapVersion: '1.1' }).properties, timeoutMs: 2_000 },
      headers: [
        { name: 'Authorization', value: 'Basic dG9wc2VjcmV0OnBhc3M=' },
        { name: 'X-Trace', value: 'abc' },
      ],
      ...extra,
    });

  it('reports a refused connection with the redacted headers, then rethrows', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const before = Date.now();

    await expect(
      sendThroughEngine(depsFor(failing(), { onSendFailed }), 'send-err', 'req-1', { draft: { kind: 'soap' } }),
    ).rejects.toMatchObject({ code: 'connection-refused' });

    expect(onSendFailed).toHaveBeenCalledTimes(1);
    const failure = onSendFailed.mock.calls[0]![0];
    expect(failure).toMatchObject({
      sendId: 'send-err',
      protocol: 'soap',
      requestId: 'req-1',
      request: {
        url: 'http://127.0.0.1:1/nope',
        method: 'POST',
        headers: { Authorization: '<redacted>', 'X-Trace': 'abc' },
      },
      error: { code: 'connection-refused' },
    });
    expect(failure.durationMs).toBeGreaterThanOrEqual(0);
    expect(Date.parse(failure.startedAt)).toBeGreaterThanOrEqual(before - 1);
    expect(JSON.stringify(failure)).not.toContain('dG9wc2VjcmV0');
    // The headers are the ones the transport was about to send, not only the resolved input's.
    const names = Object.fromEntries(Object.entries(failure.request.headers).map(([k, v]) => [k.toLowerCase(), v]));
    expect(names['content-type']).toMatch(/text\/xml/);
    expect(names).toHaveProperty('soapaction');
    const raw = Buffer.from(failure.rawRequestBase64 ?? '', 'base64').toString('utf8');
    expect(raw).toContain('POST /nope HTTP/1.1');
    expect(raw).toContain('<Envelope/>');
    expect(raw).not.toContain('dG9wc2VjcmV0');
  });

  it('records the failed send in History before the row is reported', async () => {
    const order: string[] = [];
    const recordSend = vi.fn(() => {
      order.push('history');
      return Promise.resolve(undefined);
    });
    await expect(
      sendThroughEngine(
        depsFor(failing(), { history: { recordSend } as never, onSendFailed: () => order.push('row') }),
        's-order',
        'req-1',
        { draft: { kind: 'soap' } },
      ),
    ).rejects.toMatchObject({ code: 'connection-refused' });
    expect(order).toEqual(['history', 'row']);
    expect(recordSend).toHaveBeenCalledWith(
      'p1',
      expect.objectContaining({
        requestId: 'req-1',
        error: expect.objectContaining({ code: 'connection-refused' }) as unknown,
      }),
    );
  });

  it('keeps the send error when onSendFailed itself throws', async () => {
    const onSendFailed = vi.fn(() => {
      throw new Error('listener broke');
    });

    await expect(
      sendThroughEngine(depsFor(failing(), { onSendFailed }), 'send-err-2', 'req-1', { draft: { kind: 'soap' } }),
    ).rejects.toMatchObject({ code: 'connection-refused' });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the send succeeds', async () => {
    const onSendFailed = vi.fn();

    const result = await sendThroughEngine(
      depsFor(seeded(`${server.url}/soap`), { onSendFailed }),
      'send-ok',
      'req-1',
      { draft: { kind: 'soap' } },
    );

    expect(result.http.status).toBe(200);
    expect(onSendFailed).not.toHaveBeenCalled();
  });
});

describe('sendThroughEngine (SOAP) → an ad-hoc send that fails', () => {
  const input: ResolvedSendInputWire = {
    endpoint: 'http://127.0.0.1:1/nope',
    envelopeXml: '<Envelope/>',
    soapVersion: '1.1',
    timeoutMs: 2_000,
  };

  it('reports a row with no requestId, and records History only for a resend of a known project', async () => {
    const resend = { ...META, requestName: 'Gone', projectId: 'p1' };
    for (const [names, recorded] of [
      [AD_HOC_NAME, 0],
      [resend, 1],
    ] as const) {
      const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
      const recordSend = vi.fn<(projectId: string, record: RecordSendInput) => Promise<undefined>>(() =>
        Promise.resolve(undefined),
      );
      await expect(
        sendThroughEngine(
          depsFor(seeded(server.url), { onSendFailed, history: { recordSend } as never }),
          'send-adhoc-err',
          'ad-hoc',
          { draft: { kind: 'soap' }, adHoc: { input, names } },
        ),
      ).rejects.toMatchObject({ code: 'connection-refused' });

      expect(onSendFailed).toHaveBeenCalledTimes(1);
      const failure = onSendFailed.mock.calls[0]![0];
      expect(failure).toMatchObject({
        sendId: 'send-adhoc-err',
        protocol: 'soap',
        error: { code: 'connection-refused' },
      });
      expect(failure).not.toHaveProperty('requestId');
      expect(recordSend).toHaveBeenCalledTimes(recorded);
      if (recorded === 1) {
        const [projectId, record] = recordSend.mock.calls[0]!;
        expect(projectId).toBe('p1');
        expect(record).toMatchObject({ requestName: 'Gone', error: { code: 'connection-refused' } });
        expect(record).not.toHaveProperty('requestId');
      }
    }
  });

  it('keeps the send error when onSendFailed itself throws', async () => {
    const onSendFailed = vi.fn(() => {
      throw new Error('listener broke');
    });
    await expect(
      sendThroughEngine(depsFor(seeded(server.url), { onSendFailed }), 'send-adhoc-err-2', 'ad-hoc', {
        draft: { kind: 'soap' },
        adHoc: { input, names: AD_HOC_NAME },
      }),
    ).rejects.toMatchObject({ code: 'connection-refused' });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
  });

  it('stays quiet when the send succeeds', async () => {
    const onSendFailed = vi.fn();
    const result = await sendThroughEngine(depsFor(seeded(server.url), { onSendFailed }), 'send-adhoc-ok', 'ad-hoc', {
      draft: { kind: 'soap' },
      adHoc: {
        input: {
          endpoint: `${server.url}/soap`,
          envelopeXml: '<soap:Envelope><soap:Body/></soap:Envelope>',
          soapVersion: '1.1',
        },
        names: AD_HOC_NAME,
      },
    });
    expect(result.http.status).toBe(200);
    expect(onSendFailed).not.toHaveBeenCalled();
  });
});

describe('sendThroughEngine (SOAP) → prepare-stage failures', () => {
  it('a proxy lookup that throws before the send emits a prepare row and rethrows', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const recordSend = vi.fn();
    const deps = depsFor(seeded('http://127.0.0.1:1/nope'), {
      onSendFailed,
      history: { recordSend } as never,
      project: { proxyFor: () => Promise.reject(new WirebenchError('proxy-resolve-failed', 'x')) },
    });
    await expect(sendThroughEngine(deps, 'send-prep', 'req-1', { draft: { kind: 'soap' } })).rejects.toThrow('x');
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({
      protocol: 'soap',
      stage: 'prepare',
      request: { url: 'http://127.0.0.1:1/nope', method: 'POST', headers: {} },
      error: { code: 'proxy-resolve-failed' },
    });
    expect(recordSend).not.toHaveBeenCalled();
  });

  it('History durationMs still excludes the proxy lookup', async () => {
    vi.useFakeTimers({ toFake: ['Date'] });
    try {
      const recordSend = vi.fn(() => Promise.resolve(undefined));
      const deps = depsFor(seeded(`${server.url}/calc`), {
        history: { recordSend } as never,
        project: {
          proxyFor: () => {
            vi.setSystemTime(Date.now() + 500);
            return Promise.resolve(undefined);
          },
        },
      });
      await sendThroughEngine(deps, 'send-prep', 'req-1', { draft: { kind: 'soap' } });
      const [, entry] = recordSend.mock.calls[0] as unknown as [string, { durationMs: number }];
      expect(entry.durationMs).toBeLessThan(500);
    } finally {
      vi.useRealTimers();
    }
  });
});

describe('sendThroughEngine (SOAP) → the definition the app holds', () => {
  /** `req-1` under an interface that caches its definition on disk. */
  const cachedModel = (): Project => {
    const model = seeded(`${server.url}/calc`);
    return { ...model, interfaces: model.interfaces.map((i) => ({ ...i, cacheDefinition: true })) };
  };
  /** What the app holds for the interface once imported; no binding, so nothing is validated. */
  const held = {
    definition: { bindings: [] },
    bundle: {},
    schemaSet: {},
    wsa: { defaultActionByOperation: {} },
  } as unknown as WsdlImportResult;
  /** Deps whose engine service holds `iface-1`'s definition in memory. */
  const holding = (model: Project): { deps: SendThroughEngineDeps; asked: string[] } => {
    const deps = depsFor(model);
    const asked: string[] = [];
    vi.spyOn(deps.service, 'has').mockImplementation((id) => id === 'iface-1');
    vi.spyOn(deps.service, 'resultFor').mockImplementation((id) => {
      asked.push(id);
      return held;
    });
    return { deps, asked };
  };

  beforeEach(() => {
    cacheReads.length = 0;
  });

  it('a send reads the definition cache only when the app holds no definition', async () => {
    await sendThroughEngine(depsFor(cachedModel()), 'send-cache', 'req-1', { draft: { kind: 'soap' } });
    expect(cacheReads).toHaveLength(1);
  });

  it('a send with the definition lent never reads the definition cache', async () => {
    const { deps, asked } = holding(cachedModel());
    await sendThroughEngine(deps, 'send-held', 'req-1', { draft: { kind: 'soap' } });
    expect(asked).toEqual(['iface-1']);
    expect(cacheReads).toEqual([]);
  });

  it('a cURL export with the definition lent never reads the definition cache', async () => {
    const { deps, asked } = holding(cachedModel());
    expect((await previewSoap(deps, 'req-1'))?.input.endpoint).toBe(`${server.url}/calc`);
    expect(asked).toEqual(['iface-1']);
    expect(cacheReads).toEqual([]);
  });
});
