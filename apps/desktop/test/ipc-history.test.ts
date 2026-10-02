import { createServer, type IncomingHttpHeaders } from 'node:http';
import type { AddressInfo } from 'node:net';
import { afterAll, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createInterface,
  createProject,
  createRequest,
  createRestRequest,
  entry,
  expand,
  WirebenchError,
} from '@wirebench/engine';
import type {
  AuthConfig,
  CreateRestRequestInput,
  Project,
  RestApi,
  RestSendInput,
  SoapRequestDef,
  UnresolvedRef,
} from '@wirebench/engine';
import { buildRestHistoryEntry, isTruncatedBody } from '../src/main/history-service.js';
import { grpcResendDraft, registerHistoryChannels, restResendDraft } from '../src/main/ipc/history.js';
import type { RestSendResolution } from '../src/main/rest-send.js';
import type { SendThroughEngineDeps } from '../src/main/send/exchange.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';
import { sendDepsFor, type SendDepsExtra } from './helpers/send-deps.js';

/**
 * The engine send every re-send goes through, spied on: it sends for real unless a test stubs it,
 * and what it was asked to send is what is checked.
 */
const { engineSend, real } = vi.hoisted(() => ({
  engineSend: vi.fn(),
  real: { send: undefined as unknown as (...args: unknown[]) => unknown },
}));

vi.mock('../src/main/send/exchange.js', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../src/main/send/exchange.js')>();
  real.send = actual.sendThroughEngine as never;
  return { ...actual, sendThroughEngine: engineSend };
});

beforeEach(() => {
  engineSend.mockReset();
  engineSend.mockImplementation(real.send);
});

/** The `n`th engine send's request id and options. */
function sent(n = 0): { sendId: string; requestId: string; options: Record<string, unknown> } {
  const [, sendId, requestId, options] = engineSend.mock.calls[n] as [unknown, string, string, Record<string, unknown>];
  return { sendId, requestId, options };
}

/** What the SOAP server below was sent, one request after another. */
const received: { url: string; headers: IncomingHttpHeaders; body: string }[] = [];
let soapUrl = '';
const soapServer = createServer((req, res) => {
  const chunks: Buffer[] = [];
  req.on('data', (chunk: Buffer) => chunks.push(chunk));
  req.on('end', () => {
    received.push({ url: req.url ?? '', headers: req.headers, body: Buffer.concat(chunks).toString('utf8') });
    res.writeHead(200, { 'content-type': 'text/xml' });
    res.end('<s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body><ok/></s:Body></s:Envelope>');
  });
});

beforeAll(async () => {
  await new Promise<void>((resolve) => soapServer.listen(0, '127.0.0.1', resolve));
  soapUrl = `http://127.0.0.1:${String((soapServer.address() as AddressInfo).port)}`;
});

afterAll(async () => {
  await new Promise((resolve) => soapServer.close(resolve));
});

/** A project holding SOAP request `req-1` as it is saved now. */
function soapModel(
  extra: Partial<Parameters<typeof createRequest>[1]> & { endpointUrl?: string; auth?: SoapRequestDef['auth'] } = {},
): Project {
  const { endpointUrl, auth, ...input } = extra;
  const request = {
    ...createRequest('Add', { id: 'req-1', envelopeXml: '<Envelope/>', soapVersion: '1.1', ...input }),
    ...(endpointUrl !== undefined ? { endpointUrl } : {}),
    ...(auth !== undefined ? { auth } : {}),
  };
  const iface = createInterface('Calc', {
    id: 'iface-1',
    definitionUrl: 'http://127.0.0.1:1/x?wsdl',
    cacheDefinition: false,
    operations: [{ name: 'Add', bindingName: '{urn:t}B', slug: 'add', order: 0, requests: [request] }],
  });
  return { ...createProject('Calc', { id: 'proj-1' }), interfaces: [iface] };
}

/** The engine send's dependencies over `model` (a project with nothing in it by default). */
function sendDeps(
  model: Project = createProject('None', { id: 'proj-1' }),
  extra: SendDepsExtra = {},
): SendThroughEngineDeps {
  return sendDepsFor(model, extra);
}

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender: {} }, payload);
}

function makeEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return {
    id: 'h-1',
    at: '2026-01-01T00:00:00.000Z',
    projectId: 'proj-1',
    requestName: 'Add',
    interfaceName: 'Calc',
    operationName: 'Add',
    endpoint: 'http://dev.test/soap',
    soapVersion: '1.1',
    durationMs: 5,
    ok: true,
    status: 200,
    request: { envelopeXml: '<Envelope/>', headers: [] },
    sizeBytes: 10,
    ...overrides,
  };
}

/** A project stub with no live request for any id — every resend falls back to the stored entry. */
function noLiveRequests() {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    authFor: () => undefined,
    requestMeta: () => undefined,
    // Only `req-1` still exists; any other request an entry names has been deleted since.
    projectId: (requestId: string) => (requestId === 'req-1' ? 'proj-1' : undefined),
    buildLiveSendInput: () => undefined,
  };
}

/** A fake `HistoryService` — only the surface `ipc/history.ts` calls. */
function fakeHistory(entries: HistoryEntryWire[]) {
  return {
    list: vi.fn((query?: { query?: string; projectId?: string }) => {
      const scoped = query?.projectId !== undefined ? entries.filter((e) => e.projectId === query.projectId) : entries;
      const filtered =
        query?.query !== undefined
          ? scoped.filter((e) => e.requestName.toLowerCase().includes(query.query!.toLowerCase()))
          : scoped;
      return { entries: filtered, total: filtered.length };
    }),
    get: vi.fn((id: string) => entries.find((e) => e.id === id)),
    recordSend: vi.fn(() => Promise.resolve(undefined)),
    clear: vi.fn((projectId?: string) => {
      const kept = projectId !== undefined ? entries.filter((e) => e.projectId !== projectId) : [];
      const n = entries.length - kept.length;
      entries.splice(0, entries.length, ...kept);
      return Promise.resolve(n);
    }),
    openProjectIds: vi.fn((): readonly string[] => ['proj-1']),
    open: vi.fn(() => Promise.resolve()),
    close: vi.fn(),
    closeAll: vi.fn(),
  };
}

describe('registerHistoryChannels', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('history.list returns entries and total from the history service', async () => {
    const entries = [makeEntry({ id: 'a', requestName: 'Alpha' }), makeEntry({ id: 'b', requestName: 'Beta' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
    });

    const result = await invoke('history.list', {});
    expect(result).toEqual({ ok: true, value: { entries, total: 2 } });

    const filtered = await invoke('history.list', { query: 'alpha' });
    expect(filtered).toEqual({ ok: true, value: { entries: [entries[0]], total: 1 } });
  });

  it('history.list passes the project filter through to the history service', async () => {
    const entries = [
      makeEntry({ id: 'a', requestName: 'Alpha', projectId: 'proj-1' }),
      makeEntry({ id: 'b', requestName: 'Beta', projectId: 'proj-2' }),
    ];
    const history = fakeHistory(entries);
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
    });

    const result = await invoke('history.list', { projectId: 'proj-2' });

    expect(result).toEqual({ ok: true, value: { entries: [entries[1]], total: 1 } });
    expect(history.list).toHaveBeenLastCalledWith(expect.objectContaining({ projectId: 'proj-2' }));
    // Absent means every project: the key must not be forwarded as `undefined`.
    await invoke('history.list', {});
    expect(history.list.mock.calls.at(-1)?.[0]).not.toHaveProperty('projectId');
  });

  it('history.get returns the entry or undefined', async () => {
    const entries = [makeEntry({ id: 'a' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
    });

    expect(await invoke('history.get', { id: 'a' })).toEqual({ ok: true, value: { entry: entries[0] } });
    expect(await invoke('history.get', { id: 'nope' })).toEqual({ ok: true, value: { entry: undefined } });
  });

  it('history.clear empties the store and reports how many were cleared', async () => {
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
    });

    const result = await invoke('history.clear', undefined);
    expect(result).toEqual({ ok: true, value: { cleared: 2 } });
  });

  it.each(['websocket', 'rest', 'grpc'] as const)(
    'history.resend refuses a %s entry with history-resend-unsupported, sending nothing',
    async (kind) => {
      const send = engineSend;
      registerHistoryChannels(fakeHistory([makeEntry({ id: 'k', kind })]) as never, {
        project: noLiveRequests(),
        send: sendDeps(),
      });
      const result = await invoke('history.resend', { id: 'k' });
      expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('history.resend rejects an unknown id with unknown-history-entry', async () => {
    const history = fakeHistory([]);
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
    });

    const result = await invoke('history.resend', { id: 'missing' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-history-entry' } });
  });

  it('history.resend refuses an orphaned entry carrying a redacted header, never sending it', async () => {
    // No `requestId`: the original request is gone (or this was an ad-hoc send). A redacted
    // header must never be resent verbatim — refuse instead of stripping and sending raw.
    const entries = [
      makeEntry({
        id: 'a',
        endpoint: 'http://dev.test/resend',
        request: {
          envelopeXml: '<Envelope>resend-me</Envelope>',
          headers: [{ name: 'Authorization', value: '<redacted>' }],
        },
      }),
    ];
    const history = fakeHistory(entries);
    const send = engineSend;
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
      send: sendDeps(),
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-redacted' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('history.resend uses the LIVE request when its original request still exists', async () => {
    // The saved envelope has changed since this entry was recorded; resend must carry the NEW
    // one, not the (redacted) copy captured at send time.
    const entries = [
      makeEntry({
        id: 'a',
        requestId: 'req-1',
        endpoint: 'http://dev.test/old-endpoint',
        request: {
          envelopeXml: '<Envelope>old-and-redacted<Password><redacted></Password></Envelope>',
          headers: [{ name: 'Authorization', value: '<redacted>' }],
        },
      }),
    ];
    const history = fakeHistory(entries);
    // The request as it is saved now: its endpoint, envelope and headers, sent through the engine.
    const model = soapModel({
      endpointUrl: `${soapUrl}/new-endpoint`,
      envelopeXml: '<Envelope>current, with the real password</Envelope>',
      headers: [{ name: 'X-Live', value: 'yes' }],
    });
    registerHistoryChannels(history as never, {
      project: {
        ...noLiveRequests(),
        buildLiveSendInput: (requestId: string) =>
          requestId === 'req-1'
            ? {
                endpoint: `${soapUrl}/new-endpoint`,
                envelopeXml: '<Envelope>current, with the real password</Envelope>',
                soapVersion: '1.1' as const,
                headers: { 'X-Live': 'yes' },
              }
            : undefined,
      },
      send: sendDeps(model),
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: true });
    // The saved request by id, nothing of the entry laid over it.
    expect(sent()).toMatchObject({ requestId: 'req-1', options: { draft: { kind: 'soap', override: {} } } });
    expect(sent().options).not.toHaveProperty('adHoc');
    const sentRequest = received.at(-1)!;
    expect(sentRequest.url).toBe('/new-endpoint');
    expect(sentRequest.body).toBe('<Envelope>current, with the real password</Envelope>');
    expect(sentRequest.headers['x-live']).toBe('yes');
    expect(sentRequest.headers.authorization).toBeUndefined();
  });

  it('history.resend refuses a redacted entry whose original request no longer exists', async () => {
    const entries = [
      makeEntry({
        id: 'a',
        requestId: 'req-gone',
        request: { envelopeXml: '<Envelope><Password><redacted></Password></Envelope>', headers: [] },
      }),
    ];
    const history = fakeHistory(entries);
    const send = engineSend;
    registerHistoryChannels(history as never, {
      project: noLiveRequests(), // buildLiveSendInput always undefined: the request is gone.
      send: sendDeps(),
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-redacted' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('history.resend sends an orphaned entry raw when it carries no redacted secret', async () => {
    const entries = [
      makeEntry({
        id: 'a',
        requestId: 'req-gone',
        endpoint: 'http://dev.test/orphan',
        request: { envelopeXml: '<Envelope>plain</Envelope>', headers: [{ name: 'X-Foo', value: 'bar' }] },
      }),
    ];
    const history = fakeHistory(entries);
    // The entry as recorded, sent as a synthetic item: nothing of a project behind it.
    const send = engineSend.mockResolvedValueOnce({
      sendId: 'ignored',
      durationMs: 1,
      http: {
        status: 200,
        statusText: 'OK',
        headers: {},
        rawHeaders: [],
        bodyBase64: '',
        rawBodyBase64: '',
        rawRequestBase64: '',
        rawResponseBase64: '',
        truncated: false,
        httpVersion: '1.1',
        timings: { startedAt: '2026-01-01T00:00:00.000Z', totalMs: 1 },
        redirects: [],
        request: { url: 'http://dev.test/orphan', method: 'POST', headers: {} },
      },
      problems: [],
    });
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
      send: sendDeps(),
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: true });
    const [, , requestId, options] = send.mock.calls[0]! as [
      unknown,
      string,
      string,
      { adHoc: { input: { endpoint: string; envelopeXml: string; headers: unknown } } },
    ];
    const sentRequest = options.adHoc;
    expect(requestId).toBe('ad-hoc');
    expect(sentRequest.input.endpoint).toBe('http://dev.test/orphan');
    expect(sentRequest.input.envelopeXml).toBe('<Envelope>plain</Envelope>');
    expect(sentRequest.input.headers).toEqual({ 'X-Foo': 'bar' });
    // Recorded back into the History it came from, under its own names and its gone request.
    expect(options.adHoc).toMatchObject({
      names: { requestName: 'Add', interfaceName: 'Calc', operationName: 'Add', projectId: 'proj-1' },
      requestId: 'req-gone',
    });
  });

  it('history.resend sends a request that still exists, but maps no endpoint now, as its project sends it, to the recorded endpoint', async () => {
    // The environment active now maps no endpoint for the interface, so the live input does not
    // build; the request, its project's properties, auth, keychain and proxy are all still there.
    const entries = [
      makeEntry({
        id: 'a',
        requestId: 'req-1',
        endpoint: `${soapUrl}/recorded`,
        request: { envelopeXml: '<Envelope>old</Envelope>', headers: [] },
      }),
    ];
    const model: Project = {
      ...soapModel({
        envelopeXml: '<Envelope>${#Project#token}</Envelope>',
        auth: { type: 'basic', username: 'svc', passwordRef: 'sec_pw', preemptive: true },
      }),
      properties: { token: 'abc' },
    };
    const proxyFor = vi.fn(() => Promise.resolve(undefined));
    registerHistoryChannels(fakeHistory(entries) as never, {
      project: noLiveRequests(),
      send: sendDeps(model, {
        project: { proxyFor },
        secretsFor: () => (ref) => Promise.resolve(ref === 'sec_pw' ? 'pw-1' : undefined),
        adHocScopes: () => ({ project: {}, global: { token: 'from-globals' }, system: {} }),
      }),
    });

    const result = await invoke('history.resend', { id: 'a' });

    expect(result).toMatchObject({ ok: true });
    expect(sent()).toMatchObject({
      requestId: 'req-1',
      options: { draft: { kind: 'soap', override: { endpoint: `${soapUrl}/recorded` } } },
    });
    expect(sent().options).not.toHaveProperty('adHoc');
    const last = received.at(-1)!;
    expect(last.url).toBe('/recorded');
    expect(last.body).toBe('<Envelope>abc</Envelope>');
    expect(last.headers.authorization).toBe(`Basic ${Buffer.from('svc:pw-1').toString('base64')}`);
    expect(proxyFor).toHaveBeenCalledWith('proj-1', `${soapUrl}/recorded`);
  });

  it('history.resend refuses a request that maps no endpoint now when the recorded one holds a redacted value', async () => {
    const entries = [makeEntry({ id: 'a', requestId: 'req-1', endpoint: `${soapUrl}/recorded?key=%3Credacted%3E` })];
    registerHistoryChannels(fakeHistory(entries) as never, {
      project: noLiveRequests(),
      send: sendDeps(soapModel()),
    });

    const result = await invoke('history.resend', { id: 'a' });

    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-redacted' } });
    expect(engineSend).not.toHaveBeenCalled();
  });

  it('history.resend sends an entry whose request was deleted ad hoc, never through a project', async () => {
    const entries = [makeEntry({ id: 'a', requestId: 'req-gone', endpoint: `${soapUrl}/orphan` })];
    registerHistoryChannels(fakeHistory(entries) as never, {
      project: noLiveRequests(),
      send: sendDeps(soapModel(), { project: { projectId: () => undefined } }),
    });

    const result = await invoke('history.resend', { id: 'a' });

    expect(result).toMatchObject({ ok: true });
    expect(sent()).toMatchObject({ requestId: 'ad-hoc', options: { adHoc: { requestId: 'req-gone' } } });
  });

  it('history.resend records an orphaned entry back into its History, naming the request it was sent from', async () => {
    const entries = [
      makeEntry({
        id: 'a',
        requestId: 'req-gone',
        endpoint: `${soapUrl}/orphan`,
        request: { envelopeXml: '<Envelope>plain</Envelope>', headers: [{ name: 'X-Foo', value: 'bar' }] },
      }),
    ];
    const history = fakeHistory(entries);
    const failures: unknown[] = [];
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
      send: sendDeps(undefined, {
        history: history as never,
        project: { projectId: () => undefined },
        onSendFailed: (failure) => failures.push(failure),
      }),
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: true });
    expect(received.at(-1)).toMatchObject({ url: '/orphan', body: '<Envelope>plain</Envelope>' });
    expect(received.at(-1)!.headers['x-foo']).toBe('bar');
    expect(history.recordSend).toHaveBeenCalledTimes(1);
    expect(history.recordSend.mock.calls[0]).toMatchObject([
      'proj-1',
      {
        requestId: 'req-gone',
        requestName: 'Add',
        interfaceName: 'Calc',
        operationName: 'Add',
        input: {
          endpoint: `${soapUrl}/orphan`,
          envelopeXml: '<Envelope>plain</Envelope>',
          headers: { 'X-Foo': 'bar' },
        },
      },
    ]);
    expect(failures).toEqual([]);
  });

  it('history.resend reports a failed resend to onSendFailed as a soap failure row', async () => {
    const entries = [makeEntry({ id: 'dead', endpoint: 'http://127.0.0.1:1/nope' })];
    const history = fakeHistory(entries);
    const onSendFailed = vi.fn();
    registerHistoryChannels(history as never, {
      project: noLiveRequests(),
      send: sendDeps(undefined, { onSendFailed }),
    });

    const result = await invoke('history.resend', { id: 'dead' });

    expect(result).toMatchObject({ ok: false, error: { code: 'connection-refused' } });
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]?.[0]).toMatchObject({
      protocol: 'soap',
      request: { url: 'http://127.0.0.1:1/nope', method: 'POST' },
      error: { code: 'connection-refused' },
    });
    expect(onSendFailed.mock.calls[0]?.[0]).not.toHaveProperty('requestId');
  });
});

/** A gRPC entry recorded from saved request `r-1`, with the given kind and request messages. */
function grpcEntry(methodKind: 'unary' | 'client-streaming' | 'bidi-streaming', requestMessages: string[]) {
  return makeEntry({
    id: 'g',
    kind: 'grpc',
    requestId: 'r-1',
    request: { envelopeXml: '{"typed":true}', headers: [] },
    grpc: {
      service: 'pkg.Greeter',
      method: 'SayHello',
      methodKind,
      requestMessages,
      responseMessages: [],
      trailers: [],
    },
  });
}

/**
 * The engine send stubbed by `send`, which is handed each call as `request.sendGrpc` would take it:
 * its send id, its request id and its draft, with the rest of the send's options beside them.
 */
function stubEngine(send: (call: Record<string, unknown>) => unknown): void {
  engineSend.mockImplementation(
    (_deps: unknown, sendId: string, requestId: string, options: { draft: { draft?: unknown } }) => {
      const { draft, ...rest } = options;
      return send({ sendId, requestId, ...(draft.draft !== undefined ? { draft: draft.draft } : {}), ...rest });
    },
  );
}

/** Registers the channels with a gRPC sender stub and a project that knows request `r-1`. */
function registerGrpc(entries: HistoryEntryWire[], send = vi.fn(() => Promise.resolve({}))) {
  stubEngine(send);
  registerHistoryChannels(fakeHistory(entries) as never, {
    project: { ...noLiveRequests(), grpcSend: ((id: string) => (id === 'r-1' ? {} : undefined)) as never },
    send: sendDeps(),
  });
  return send;
}

describe('history.resendGrpc', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('rejects an unknown id with unknown-history-entry', async () => {
    const send = registerGrpc([]);
    const result = await invoke('history.resendGrpc', { id: 'missing' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-history-entry' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a SOAP entry with history-resend-unsupported', async () => {
    const send = registerGrpc([makeEntry({ id: 's', requestId: 'r-1' })]);
    const result = await invoke('history.resendGrpc', { id: 's' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an entry whose saved request is gone with history-resend-orphan', async () => {
    const gone = { ...grpcEntry('unary', ['{}']), requestId: 'r-deleted' };
    const adHoc: HistoryEntryWire = { ...grpcEntry('unary', ['{}']), id: 'a' };
    delete adHoc.requestId;
    const send = registerGrpc([gone, adHoc]);
    for (const id of ['g', 'a']) {
      const result = await invoke('history.resendGrpc', { id });
      expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-orphan' } });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sends a unary call through the saved request with the recorded message, not interactively', async () => {
    const send = registerGrpc([grpcEntry('unary', ['{"name":"Ada"}'])]);
    // The stub's reply is no real exchange summary, so only what went out is checked here.
    await invoke('history.resendGrpc', { id: 'g' });
    expect(send).toHaveBeenCalledTimes(1);
    const [sentCall] = send.mock.calls[0]! as unknown as [Record<string, unknown>];
    expect(sentCall).toMatchObject({
      requestId: 'r-1',
      draft: { service: 'pkg.Greeter', method: 'SayHello', methodKind: 'unary', message: '{"name":"Ada"}' },
    });
    expect(typeof sentCall['sendId']).toBe('string');
    expect(sentCall).not.toHaveProperty('interactive');
    // Nothing on screen holds a resend's send id, so it reports no live events to the window.
    expect(sentCall).not.toHaveProperty('onLive');
  });

  it.each(['client-streaming', 'bidi-streaming'] as const)(
    'gives a %s call every recorded message, in order, as one JSON array',
    (kind) => {
      const draft = grpcResendDraft(grpcEntry(kind, ['{"n":1}', '{"n":2}', '{"n":3}']) as never);
      expect(JSON.parse(draft.message!)).toEqual([{ n: 1 }, { n: 2 }, { n: 3 }]);
      expect(draft.message).toContain('\n');
    },
  );

  it('falls back to the recorded request text when no message went out', () => {
    expect(grpcResendDraft(grpcEntry('client-streaming', []) as never).message).toBe('{"typed":true}');
  });

  it('passes an error from the send through', async () => {
    registerGrpc(
      [grpcEntry('unary', ['{}'])],
      vi.fn(() => Promise.reject(new WirebenchError('grpc-unavailable', 'down'))),
    );
    const result = await invoke('history.resendGrpc', { id: 'g' });
    expect(result).toMatchObject({ ok: false, error: { code: 'grpc-unavailable' } });
  });
});

/** A REST entry recorded from saved request `r-1`: a POST that got a 200 from `endpoint`. */
function restEntry(overrides: Partial<HistoryEntryWire> = {}): HistoryEntryWire {
  return makeEntry({
    id: 'r',
    kind: 'rest',
    requestId: 'r-1',
    method: 'POST',
    soapVersion: 'none',
    endpoint: 'https://api.test/pets/7?expand=owner',
    request: { envelopeXml: '{"name":"Rex"}', headers: [{ name: 'X-Trace', value: 'abc' }] },
    response: { envelopeXml: '{}', rawHeaders: [], status: 200, statusText: 'OK' },
    ...overrides,
  });
}

/** The saved request `r-1` as `project.restSend` resolves it: the request as typed, and its auth. */
function savedRest(input: CreateRestRequestInput = {}, auth: AuthConfig = { type: 'none' }) {
  return { request: createRestRequest('Pet', { id: 'r-1', ...input }), auth };
}

/** The code `run` throws with, or `undefined` when it returns. */
function refusal(run: () => unknown): string | undefined {
  try {
    run();
  } catch (error) {
    return (error as WirebenchError).code;
  }
  return undefined;
}

/** The origin every `restEntry()` and default `savedRest()` URL shares, for a matching resend. */
const ORIGIN = 'https://api.test';

describe('restResendDraft', () => {
  it('takes the method, URL, query, headers and body from the entry, in the saved raw body’s language', () => {
    const saved = savedRest({
      method: 'GET',
      url: '/pets/{id}',
      pathParams: [entry('id', '1')],
      body: { kind: 'raw', language: 'json', contentType: 'application/vnd.pet+json', text: '{}' },
    });
    expect(restResendDraft(restEntry(), saved, ORIGIN)).toEqual({
      method: 'POST',
      url: 'https://api.test/pets/7',
      query: [{ name: 'expand', value: 'owner', enabled: true }],
      pathParams: [],
      headers: [{ name: 'X-Trace', value: 'abc', enabled: true }],
      body: { kind: 'raw', language: 'json', contentType: 'application/vnd.pet+json', text: '{"name":"Rex"}' },
    });
  });

  it('fills a redacted header from the last enabled saved row of that name, as typed', () => {
    const recorded = restEntry({ request: { envelopeXml: '', headers: [{ name: 'X-Token', value: '<redacted>' }] } });
    const saved = savedRest({
      headers: [
        entry('x-token', 'old'),
        entry('X-TOKEN', '${secret:token}'),
        entry('X-Token', 'off', { enabled: false }),
      ],
    });
    expect(restResendDraft(recorded, saved, ORIGIN).headers).toEqual([
      { name: 'X-Token', value: '${secret:token}', enabled: true },
    ]);
  });

  it('fills a query value masked by URLSearchParams and reads its + as a space', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?sig=%3Credacted%3E&note=a+b' });
    const saved = savedRest({ url: '/pets?sig=${#Env#sig}' });
    expect(restResendDraft(recorded, saved, ORIGIN).query).toEqual([
      { name: 'sig', value: '${#Env#sig}', enabled: true },
      { name: 'note', value: 'a%20b', enabled: true },
    ]);
  });

  it('fills a query value masked in its literal form from the last saved Query row, keeping a +', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?token=<redacted>&note=a+b' });
    const saved = savedRest({ query: [entry('token', 'first'), entry('token', '${secret:t}')] });
    expect(restResendDraft(recorded, saved, ORIGIN).query).toEqual([
      { name: 'token', value: '${secret:t}', enabled: true },
      { name: 'note', value: 'a+b', enabled: true },
    ]);
  });

  it('drops a query API key, masked or not, when the effective auth puts one in the query', () => {
    const auth: AuthConfig = { type: 'api-key', name: 'api_key', in: 'query', valueRef: 'sec_key' };
    for (const endpoint of [
      'https://api.test/pets?api_key=%3Credacted%3E&q=1',
      'https://api.test/pets?api_key=live-key&q=1',
    ]) {
      expect(restResendDraft(restEntry({ endpoint }), savedRest({}, auth), ORIGIN).query).toEqual([
        { name: 'q', value: '1', enabled: true },
      ]);
    }
  });

  it('drops a query API key whose name is percent- or plus-encoded in the recorded URL', () => {
    const auth: AuthConfig = { type: 'api-key', name: 'api key', in: 'query', valueRef: 'sec_key' };
    for (const endpoint of [
      'https://api.test/pets?api+key=%3Credacted%3E&q=1',
      'https://api.test/pets?api%20key=live&q=1',
    ]) {
      expect(restResendDraft(restEntry({ endpoint }), savedRest({}, auth), ORIGIN).query).toEqual([
        { name: 'q', value: '1', enabled: true },
      ]);
    }
  });

  it('fills a query value masked under an encoded name from the saved Query row typed as that name', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?api+key=%3Credacted%3E' });
    const saved = savedRest({ query: [entry('api key', '${secret:k}')] }, { type: 'bearer', tokenRef: 'sec_t' });
    expect(restResendDraft(recorded, saved, ORIGIN).query).toEqual([
      { name: 'api%20key', value: '${secret:k}', enabled: true },
    ]);
  });

  it('treats a recorded key as an ordinary redacted value once the auth is no longer a query key', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?api_key=%3Credacted%3E' });
    expect(refusal(() => restResendDraft(recorded, savedRest({}, { type: 'bearer', tokenRef: 'sec_t' }), ORIGIN))).toBe(
      'history-resend-redacted',
    );
  });

  it('keeps the saved URL for an entry with no response', () => {
    const failed: HistoryEntryWire = { ...restEntry({ endpoint: 'https://api.test' }) };
    delete failed.response;
    const draft = restResendDraft(failed, savedRest({ url: '/pets' }), ORIGIN);
    expect(draft).not.toHaveProperty('url');
    expect(draft).not.toHaveProperty('query');
    expect(draft).not.toHaveProperty('pathParams');
  });

  it('reuses the recorded URL when its origin matches the saved request’s', () => {
    const draft = restResendDraft(restEntry(), savedRest({ url: '/pets/{id}' }), ORIGIN);
    expect(draft.url).toBe('https://api.test/pets/7');
  });

  it('refuses with history-resend-origin when a redirect recorded a different origin', () => {
    const recorded = restEntry({ endpoint: 'https://cdn.other/pets/7?expand=owner' });
    expect(refusal(() => restResendDraft(recorded, savedRest({ url: '/pets' }), ORIGIN))).toBe('history-resend-origin');
  });

  it('refuses with history-resend-origin when the request now resolves to another host (an environment switch)', () => {
    const recorded = restEntry({ endpoint: 'https://staging.api.test/pets/7' });
    expect(refusal(() => restResendDraft(recorded, savedRest({ url: '/pets/{id}' }), ORIGIN))).toBe(
      'history-resend-origin',
    );
  });

  it('refuses with history-resend-origin when savedOrigin is undefined', () => {
    expect(refusal(() => restResendDraft(restEntry(), savedRest({ url: '/pets' }), undefined))).toBe(
      'history-resend-origin',
    );
  });

  it('refuses with history-resend-origin when the recorded URL does not parse', () => {
    const recorded = restEntry({ endpoint: 'not a url' });
    expect(refusal(() => restResendDraft(recorded, savedRest(), ORIGIN))).toBe('history-resend-origin');
  });

  it('says why an origin refusal happened', () => {
    const recorded = restEntry({ endpoint: 'https://cdn.other/pets/7' });
    expect(() => restResendDraft(recorded, savedRest(), ORIGIN)).toThrow(
      'This entry was sent to another host (a redirect or another environment); re-send it from the request.',
    );
  });

  it('keeps the saved URL for an entry with no response even when savedOrigin is undefined', () => {
    const failed: HistoryEntryWire = { ...restEntry({ endpoint: 'https://cdn.other' }) };
    delete failed.response;
    expect(restResendDraft(failed, savedRest({ url: '/pets' }), undefined)).not.toHaveProperty('url');
  });

  it('sends recorded query text literally: a ${…} in a recorded name or value is escaped, not expanded', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/cb?x=${secret:s}&${n}=1' });
    expect(restResendDraft(recorded, savedRest(), ORIGIN).query).toEqual([
      { name: 'x', value: '$${secret:s}', enabled: true },
      { name: '$${n}', value: '1', enabled: true },
    ]);
  });

  it('escapes a ${…} in the recorded path', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/a${x}/b' });
    expect(restResendDraft(recorded, savedRest(), ORIGIN).url).toBe('https://api.test/a$${x}/b');
  });

  it('escapes a ${…} in a recorded header name and value, but not a value filled from a saved row', () => {
    const recorded = restEntry({
      request: {
        envelopeXml: '',
        headers: [
          { name: 'X-Echo', value: 'a ${secret:s} b' },
          { name: 'X-${n}', value: '1' },
          { name: 'X-Token', value: '<redacted>' },
        ],
      },
    });
    const saved = savedRest({ headers: [entry('X-Token', '${secret:token}')] });
    expect(restResendDraft(recorded, saved, ORIGIN).headers).toEqual([
      { name: 'X-Echo', value: 'a $${secret:s} b', enabled: true },
      { name: 'X-$${n}', value: '1', enabled: true },
      { name: 'X-Token', value: '${secret:token}', enabled: true },
    ]);
  });

  it('does not escape a query value filled from a saved row', () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets?token=<redacted>&note=${x}' });
    const saved = savedRest({ query: [entry('token', '${secret:t}')] });
    expect(restResendDraft(recorded, saved, ORIGIN).query).toEqual([
      { name: 'token', value: '${secret:t}', enabled: true },
      { name: 'note', value: '$${x}', enabled: true },
    ]);
  });

  it('escapes a ${…} in the recorded body, raw in either language', () => {
    const recorded = restEntry({ request: { envelopeXml: '{"t":"${secret:s}"}', headers: [] } });
    expect(restResendDraft(recorded, savedRest(), ORIGIN).body).toEqual({
      kind: 'raw',
      language: 'json',
      text: '{"t":"$${secret:s}"}',
    });
    const saved = savedRest({ body: { kind: 'raw', language: 'json', text: '{}' } });
    expect(restResendDraft(recorded, saved, ORIGIN).body).toMatchObject({ text: '{"t":"$${secret:s}"}' });
  });

  it.each(['${secret:s}', '$${x}', '$$${x}', 'a${#Env#h}b${', '${${x}}', 'plain', '$', '${'])(
    'the escape of %s expands back to exactly that text, reaching no reference',
    (text) => {
      const recorded = restEntry({ request: { envelopeXml: text, headers: [] } });
      const sent = restResendDraft(recorded, savedRest(), ORIGIN).body as { text: string };
      const result = expand(sent.text, { project: { x: 'X' }, global: {}, system: {}, secrets: { s: 'S' } });
      expect(result.text).toBe(text);
      expect(result.unresolved).toEqual([]);
    },
  );

  it('treats a host differing only in case as the same origin', () => {
    const draft = restResendDraft(restEntry(), savedRest({ url: '/pets/{id}' }), 'https://API.TEST');
    expect(draft.url).toBe('https://api.test/pets/7');
  });

  it('sends the saved non-raw body as it is when the entry recorded no text', () => {
    const recorded = restEntry({ request: { envelopeXml: '', headers: [] } });
    const saved = savedRest({ body: { kind: 'form', fields: [entry('a', '1')] } });
    expect(restResendDraft(recorded, saved, ORIGIN)).not.toHaveProperty('body');
  });

  it.each([
    ['{"a":1}', 'json'],
    ['<a/>', 'xml'],
    ['plain words', 'text'],
  ] as const)('sends %s as a raw %s body when the saved request has no raw body', (text, language) => {
    const recorded = restEntry({ request: { envelopeXml: text, headers: [] } });
    expect(restResendDraft(recorded, savedRest(), ORIGIN).body).toEqual({ kind: 'raw', language, text });
  });

  it.each([
    [
      'an unfillable header',
      restEntry({ request: { envelopeXml: '', headers: [{ name: 'X-Key', value: '<redacted>' }] } }),
    ],
    ['an unfillable query value', restEntry({ endpoint: 'https://api.test/pets?sig=%3Credacted%3E' })],
    ['the marker in the path', restEntry({ endpoint: 'https://api.test/%3Credacted%3E/pets' })],
    ['the marker in the user info', restEntry({ endpoint: 'https://u:%3Credacted%3E@api.test/pets' })],
    ['the marker in the fragment', restEntry({ endpoint: 'https://api.test/pets#%3Credacted%3E' })],
    ['the marker in the body', restEntry({ request: { envelopeXml: '{"password":"<redacted>"}', headers: [] } })],
  ])('refuses %s with history-resend-redacted', (_what, recorded) => {
    expect(refusal(() => restResendDraft(recorded, savedRest(), ORIGIN))).toBe('history-resend-redacted');
  });

  it('refuses History’s truncated copy of a body with history-resend-truncated', () => {
    const stored = buildRestHistoryEntry('proj-1', {
      requestId: 'r-1',
      requestName: 'Pet',
      apiName: 'Petstore',
      folderPath: '',
      method: 'POST',
      url: 'https://api.test/pets',
      requestHeaders: {},
      requestBody: 'x'.repeat(300 * 1024),
      durationMs: 1,
    }).request.envelopeXml;
    expect(isTruncatedBody(stored)).toBe(true);
    expect(isTruncatedBody('x'.repeat(1024))).toBe(false);
    const recorded = restEntry({ request: { envelopeXml: stored, headers: [] } });
    expect(refusal(() => restResendDraft(recorded, savedRest(), ORIGIN))).toBe('history-resend-truncated');
  });
});

/**
 * `deps.project.restSend`'s reply for `r-1`: `savedRest`'s request and auth, resolved to `ORIGIN` —
 * the property expansion `savedOriginOf` reads to decide whether the recorded URL is reusable.
 * `unresolved` stands for property references left unresolved *elsewhere* on the saved request
 * (a header, the body): `savedOriginOf` must ignore them and look at the URL alone.
 */
function savedRestSend(
  input: CreateRestRequestInput = {},
  auth: AuthConfig = { type: 'none' },
  unresolved: UnresolvedRef[] = [],
): RestSendResolution {
  const saved = savedRest(input, auth);
  return {
    ...saved,
    input: { baseUrl: ORIGIN, request: { url: saved.request.url } } as RestSendInput,
    unresolved,
    api: {} as RestApi,
    baseUrlSource: 'api',
  };
}

/** Registers the channels with a REST sender stub and a project that knows request `r-1`. */
function registerRest(
  entries: HistoryEntryWire[],
  send = vi.fn(() => Promise.resolve({})),
  withSender = true,
  saved: RestSendResolution = savedRestSend(),
) {
  stubEngine(send);
  registerHistoryChannels(fakeHistory(entries) as never, {
    project: { ...noLiveRequests(), restSend: (id: string) => (id === 'r-1' ? saved : undefined) },
    ...(withSender ? { send: sendDeps() } : {}),
  });
  return send;
}

describe('history.resendRest', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('rejects an unknown id with unknown-history-entry', async () => {
    const send = registerRest([]);
    const result = await invoke('history.resendRest', { id: 'missing' });
    expect(result).toMatchObject({ ok: false, error: { code: 'unknown-history-entry' } });
    expect(send).not.toHaveBeenCalled();
  });

  it.each([
    ['a SOAP entry', makeEntry({ id: 'x', requestId: 'r-1' })],
    ['a gRPC entry', { ...grpcEntry('unary', ['{}']), id: 'x' }],
  ])('refuses %s with history-resend-unsupported', async (_what, recorded) => {
    const send = registerRest([recorded]);
    const result = await invoke('history.resendRest', { id: 'x' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a REST entry when main has no engine send', async () => {
    registerRest([restEntry()], undefined, false);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
  });

  it('refuses an event stream, and a failed send that asked for one, with rest-resend-streaming', async () => {
    const streamed = restEntry({
      id: 's',
      sse: { rows: [], counts: { events: 0, comments: 0, retries: 0, bytes: 0 }, lastEventId: '', endedBy: 'server' },
    });
    const asked: HistoryEntryWire = {
      ...restEntry({
        id: 'a',
        request: { envelopeXml: '', headers: [{ name: 'accept', value: 'Text/Event-Stream' }] },
      }),
    };
    delete asked.response;
    const send = registerRest([streamed, asked]);
    for (const id of ['s', 'a']) {
      const result = await invoke('history.resendRest', { id });
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'rest-resend-streaming', message: 'Event streams resend from the editor.' },
      });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses an entry whose saved request is gone with history-resend-orphan', async () => {
    const gone = restEntry({ id: 'g', requestId: 'r-deleted' });
    const adHoc = restEntry({ id: 'h' });
    delete adHoc.requestId;
    const send = registerRest([gone, adHoc]);
    for (const id of ['g', 'h']) {
      const result = await invoke('history.resendRest', { id });
      expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-orphan' } });
    }
    expect(send).not.toHaveBeenCalled();
  });

  it('sends through the saved request with a fresh send id and the built draft', async () => {
    const recorded = restEntry();
    const send = registerRest([recorded]);
    // The stub's reply is no real exchange summary, so only what went out is checked here.
    await invoke('history.resendRest', { id: 'r' });
    expect(send).toHaveBeenCalledTimes(1);
    const [{ sendId, ...sent }] = send.mock.calls[0]! as unknown as [Record<string, unknown>];
    expect(typeof sendId).toBe('string');
    expect(sent).toEqual({ requestId: 'r-1', draft: restResendDraft(recorded, savedRest(), ORIGIN) });
  });

  it('reuses the recorded URL when it shares the saved request’s origin', async () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets/9?expand=owner' });
    const send = registerRest([recorded]);
    await invoke('history.resendRest', { id: 'r' });
    const [{ draft }] = send.mock.calls[0]! as unknown as [{ draft: { url?: string } }];
    expect(draft.url).toBe('https://api.test/pets/9');
  });

  it('refuses an entry captured on another origin — a redirect the entry keeps no trail of — sending nothing', async () => {
    const recorded = restEntry({ endpoint: 'https://cdn.other/pets/7?expand=owner&sig=leaked' });
    const send = registerRest([recorded]);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-origin' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('still reuses the recorded URL when a header elsewhere on the saved request has an unresolved ${secret:…}', async () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets/9?expand=owner' });
    const saved = savedRestSend({ headers: [entry('Authorization', 'Bearer ${secret:token}')] }, undefined, [
      { expr: '${secret:token}', scope: 'Secret', name: 'token', code: 'missing', start: 0, end: 0 },
    ]);
    const send = registerRest([recorded], undefined, true, saved);
    await invoke('history.resendRest', { id: 'r' });
    const [{ draft }] = send.mock.calls[0]! as unknown as [{ draft: { url?: string } }];
    // The unresolved secret is on a header, not the URL, so it must not force an origin refusal.
    expect(draft.url).toBe('https://api.test/pets/9');
  });

  it('refuses with history-resend-origin when the saved URL itself has an unresolved property reference', async () => {
    const recorded = restEntry({ endpoint: 'https://api.test/pets/9?expand=owner' });
    const saved = savedRestSend({ url: '/pets/${#Env#id}' });
    const send = registerRest([recorded], undefined, true, saved);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-origin' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses a draft that cannot be built without sending anything', async () => {
    const send = registerRest([restEntry({ endpoint: 'https://api.test/pets?sig=%3Credacted%3E' })]);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-redacted' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('refuses History’s truncated copy of a body with history-resend-truncated, sending nothing', async () => {
    const stored = buildRestHistoryEntry('proj-1', {
      requestId: 'r-1',
      requestName: 'Pet',
      apiName: 'Petstore',
      folderPath: '',
      method: 'POST',
      url: 'https://api.test/pets',
      requestHeaders: {},
      requestBody: 'x'.repeat(300 * 1024),
      durationMs: 1,
    }).request.envelopeXml;
    const recorded = restEntry({ request: { envelopeXml: stored, headers: [] } });
    const send = registerRest([recorded]);
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-truncated' } });
    expect(send).not.toHaveBeenCalled();
  });

  it('passes an error from the send through', async () => {
    registerRest(
      [restEntry()],
      vi.fn(() => Promise.reject(new WirebenchError('rest-unresolved-properties', 'unresolved'))),
    );
    const result = await invoke('history.resendRest', { id: 'r' });
    expect(result).toMatchObject({ ok: false, error: { code: 'rest-unresolved-properties' } });
  });
});
