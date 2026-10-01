// @vitest-environment node
/**
 * A desktop SOAP send through the engine's `openExchange` (`sendThroughEngine`), ported from
 * `send-with-history.test.ts`: it records the same History row and answers the same summary as the
 * app's own SOAP path did, for a saved request with the editor's envelope over it and for an ad-hoc
 * send or resend; a failed send's row carries the redacted headers and leaves the send's own error;
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
  toSoapSendInput,
  WirebenchError,
} from '@wirebench/engine';
import type { HeaderEntry, Project, PropertyScopes, SoapRequestDef } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { HistoryService } from '../src/main/history-service.js';
import { sendAndRecordHistory } from '../src/main/send-with-history.js';
import { soapOverrideOf } from '../src/main/send/draft.js';
import { sendThroughEngine, type SendThroughEngineDeps } from '../src/main/send/exchange.js';
import { AD_HOC_NAME } from '../src/main/send/record.js';
import type {
  ExchangeSummary,
  FailedExchangeWire,
  HistoryEntryWire,
  ResolvedSendInputWire,
} from '../src/shared/wire-types.js';
import { sendDepsFor } from './helpers/send-deps.js';

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

/** The input `withRequestProperties` built for the old path: the saved knobs over the editor's text. */
function oldInput(model: Project, editor: ReturnType<typeof editorInput>): ResolvedSendInputWire {
  const request = model.interfaces[0]!.operations[0]!.requests[0]!;
  const input = toSoapSendInput({
    request: {
      properties: request.properties,
      soapVersion: request.soapVersion,
      ...(request.soapAction !== undefined ? { soapAction: request.soapAction } : {}),
      headers: Object.entries(editor.headers).map(([name, value]) => ({ name, value })),
      envelopeXml: editor.envelopeXml,
    },
    endpoint: editor.endpoint,
    preferences: DEFAULT_PREFERENCES,
    projectSettings: model.settings,
  });
  return {
    endpoint: input.endpoint,
    envelopeXml: input.envelopeXml,
    soapVersion: input.soapVersion,
    ...(input.soapAction !== undefined ? { soapAction: input.soapAction } : {}),
    ...(input.headers !== undefined ? { headers: { ...input.headers } } : {}),
    ...(input.timeoutMs !== undefined ? { timeoutMs: input.timeoutMs } : {}),
    ...(input.encoding !== undefined ? { encoding: input.encoding } : {}),
    ...(input.followRedirects !== undefined ? { followRedirects: input.followRedirects } : {}),
    ...(input.skipSoapAction !== undefined ? { skipSoapAction: input.skipSoapAction } : {}),
  };
}

const oldProject = (model: Project, extra: Record<string, unknown> = {}) => ({
  scopesFor: () => ({ project: { ...model.properties }, global: {}, system: process.env }),
  authFor: () => undefined,
  requestMeta: () => META,
  projectId: () => 'p1',
  ...extra,
});

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

/** One send through the app's own SOAP path, into a real History. */
async function sendOld(
  model: Project,
  request: { requestId?: string; input: ResolvedSendInputWire },
  fallback = AD_HOC_NAME,
  scopes?: PropertyScopes,
): Promise<{ entry: HistoryEntryWire | undefined; summary: ExchangeSummary }> {
  const appended: HistoryEntryWire[] = [];
  const summary = await sendAndRecordHistory(
    new EngineService(),
    {
      project: oldProject(model),
      history: await openHistory(),
      onHistoryAppended: (wire) => appended.push(wire),
      ...(scopes !== undefined ? { adHocScopes: () => scopes } : {}),
    },
    { sendId: 's0', ...request },
    fallback,
  );
  return { entry: appended[0], summary };
}

describe('sendThroughEngine for a SOAP request', () => {
  // Task 17 deletes these comparisons with the old path.
  it('records the same History row and answers the same summary as the old SOAP path', async () => {
    const model = seeded('http://127.0.0.1:1/never');
    const editor = editorInput(
      `${server.url}/calc`,
      '<soap:Envelope><soap:Body>${#Project#who} draft</soap:Body></soap:Envelope>',
    );
    const before = await sendOld(model, { requestId: 'req-1', input: oldInput(model, editor) });
    const appended: HistoryEntryWire[] = [];
    const after = await sendThroughEngine(
      depsFor(model, { history: await openHistory(), onHistoryAppended: (wire) => appended.push(wire) }),
      's1',
      'req-1',
      { draft: { kind: 'soap', override: soapOverrideOf(editor) } },
    );
    expect(server.bodies.at(-1)).toContain('ada draft');
    expect(normalise(appended[0])).toEqual(normalise(before.entry));
    expect(normalise(after)).toEqual(normalise(before.summary));
  });

  it('records the same History row for an ad-hoc send and an ad-hoc resend as the old path', async () => {
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
    for (const names of [AD_HOC_NAME, resend]) {
      const before = await sendOld(model, { input }, names, scopes);
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
      expect(normalise(appended[0])).toEqual(normalise(before.entry));
      expect(normalise(after)).toEqual(normalise(before.summary));
    }
    // A plain ad-hoc send names no project, so nothing was recorded; the resend went back into p1.
    const history = await openHistory();
    expect(history.list().entries.map((entry) => entry.requestName)).toEqual(['Gone', 'Gone']);
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
    const before = server.bodies.length;
    await expect(
      sendThroughEngine(
        depsFor(model, { history: { recordSend } as never, onHistoryAppended: (wire) => appended.push(wire) }),
        's1',
        'req-1',
        { draft: { kind: 'soap', override: soapOverrideOf(editorInput(`${server.url}/calc`, '<a>${nope}</a>')) } },
      ),
    ).rejects.toMatchObject({ code: 'unresolved-properties' });
    expect(recordSend).not.toHaveBeenCalled();
    expect(appended).toEqual([]);
    expect(server.bodies.length).toBe(before);
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
