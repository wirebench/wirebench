import { beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { grpcResendDraft, registerHistoryChannels } from '../src/main/ipc/history.js';
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
