import { beforeEach, describe, expect, it, vi } from 'vitest';
import { createRestRequest, entry, WirebenchError } from '@wirebench/engine';
import type { AuthConfig, CreateRestRequestInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { buildRestHistoryEntry, isTruncatedBody } from '../src/main/history-service.js';
import { grpcResendDraft, registerHistoryChannels, restResendDraft } from '../src/main/ipc/history.js';
import type { HistoryEntryWire } from '../src/shared/wire-types.js';

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
    projectId: () => 'proj-1',
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
    registerHistoryChannels(new EngineService(), history as never, {
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
    registerHistoryChannels(new EngineService(), history as never, {
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
    registerHistoryChannels(new EngineService(), history as never, {
      project: noLiveRequests(),
    });

    expect(await invoke('history.get', { id: 'a' })).toEqual({ ok: true, value: { entry: entries[0] } });
    expect(await invoke('history.get', { id: 'nope' })).toEqual({ ok: true, value: { entry: undefined } });
  });

  it('history.clear empties the store and reports how many were cleared', async () => {
    const entries = [makeEntry({ id: 'a' }), makeEntry({ id: 'b' })];
    const history = fakeHistory(entries);
    registerHistoryChannels(new EngineService(), history as never, {
      project: noLiveRequests(),
    });

    const result = await invoke('history.clear', undefined);
    expect(result).toEqual({ ok: true, value: { cleared: 2 } });
  });

  it.each(['websocket', 'rest', 'grpc'] as const)(
    'history.resend refuses a %s entry with history-resend-unsupported, sending nothing',
    async (kind) => {
      const service = new EngineService();
      const send = vi.spyOn(service, 'send');
      registerHistoryChannels(service, fakeHistory([makeEntry({ id: 'k', kind })]) as never, {
        project: noLiveRequests(),
      });
      const result = await invoke('history.resend', { id: 'k' });
      expect(result).toMatchObject({ ok: false, error: { code: 'history-resend-unsupported' } });
      expect(send).not.toHaveBeenCalled();
    },
  );

  it('history.resend rejects an unknown id with unknown-history-entry', async () => {
    const history = fakeHistory([]);
    registerHistoryChannels(new EngineService(), history as never, {
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
    const engine = new EngineService();
    const send = vi.spyOn(engine, 'send');
    registerHistoryChannels(engine, history as never, {
      project: noLiveRequests(),
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
    const engine = new EngineService();
    const send = vi.spyOn(engine, 'send').mockResolvedValue({
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
        request: { url: 'http://dev.test/new-endpoint', method: 'POST', headers: {} },
      },
      problems: [],
    });
    registerHistoryChannels(engine, history as never, {
      project: {
        ...noLiveRequests(),
        buildLiveSendInput: (requestId: string) =>
          requestId === 'req-1'
            ? {
                endpoint: 'http://dev.test/new-endpoint',
                envelopeXml: '<Envelope>current, with the real password</Envelope>',
                soapVersion: '1.1' as const,
                headers: { 'X-Live': 'yes' },
              }
            : undefined,
      },
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: true });
    const [sentRequest] = send.mock.calls[0]!;
    expect(sentRequest.input.endpoint).toBe('http://dev.test/new-endpoint');
    expect(sentRequest.input.envelopeXml).toBe('<Envelope>current, with the real password</Envelope>');
    expect(sentRequest.input.headers).toEqual({ 'X-Live': 'yes' });
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
    const engine = new EngineService();
    const send = vi.spyOn(engine, 'send');
    registerHistoryChannels(engine, history as never, {
      project: noLiveRequests(), // buildLiveSendInput always undefined: the request is gone.
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
    const engine = new EngineService();
    const send = vi.spyOn(engine, 'send').mockResolvedValue({
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
    registerHistoryChannels(engine, history as never, {
      project: noLiveRequests(),
    });

    const result = await invoke('history.resend', { id: 'a' });
    expect(result).toMatchObject({ ok: true });
    const [sentRequest] = send.mock.calls[0]!;
    expect(sentRequest.input.endpoint).toBe('http://dev.test/orphan');
    expect(sentRequest.input.envelopeXml).toBe('<Envelope>plain</Envelope>');
    expect(sentRequest.input.headers).toEqual({ 'X-Foo': 'bar' });
  });

  it('history.resend reports a failed resend to onSendFailed as a soap failure row', async () => {
    const entries = [makeEntry({ id: 'dead', endpoint: 'http://127.0.0.1:1/nope' })];
    const history = fakeHistory(entries);
    const onSendFailed = vi.fn();
    registerHistoryChannels(new EngineService(), history as never, {
      project: noLiveRequests(),
      onSendFailed,
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

/** Registers the channels with a gRPC sender stub and a project that knows request `r-1`. */
function registerGrpc(entries: HistoryEntryWire[], send = vi.fn(() => Promise.resolve({}))) {
  registerHistoryChannels(new EngineService(), fakeHistory(entries) as never, {
    project: { ...noLiveRequests(), grpcSend: ((id: string) => (id === 'r-1' ? {} : undefined)) as never },
    grpc: { send: send as never },
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
    const [sent, sender] = send.mock.calls[0]! as unknown as [Record<string, unknown>, unknown];
    expect(sent).toMatchObject({
      requestId: 'r-1',
      draft: { service: 'pkg.Greeter', method: 'SayHello', methodKind: 'unary', message: '{"name":"Ada"}' },
    });
    expect(typeof sent['sendId']).toBe('string');
    expect(sent).not.toHaveProperty('interactive');
    expect(sender).toEqual({});
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

  it('falls back to the saved URL when a redirect recorded a different origin', () => {
    const recorded = restEntry({ endpoint: 'https://cdn.other/pets/7?expand=owner' });
    const draft = restResendDraft(recorded, savedRest({ url: '/pets' }), ORIGIN);
    expect(draft).not.toHaveProperty('url');
    expect(draft).not.toHaveProperty('query');
    expect(draft).not.toHaveProperty('pathParams');
  });

  it('falls back to the saved URL when savedOrigin is undefined', () => {
    const draft = restResendDraft(restEntry(), savedRest({ url: '/pets' }), undefined);
    expect(draft).not.toHaveProperty('url');
    expect(draft).not.toHaveProperty('query');
    expect(draft).not.toHaveProperty('pathParams');
  });

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
