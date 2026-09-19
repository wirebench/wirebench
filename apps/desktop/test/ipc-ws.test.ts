// @vitest-environment node
/**
 * The three WebSocket channels end to end: `request.openWs` against a real server, driven by
 * `request.wsSend`/`request.wsClose`, with `ws.live` events collected on a fake sender, plus the
 * prepare-stage failure row, the URL-masking of an API key configured "in query", the proxy path,
 * `request.preflightWs`, `request.curl` and `request.cancel`. Every wait is a bounded poll on an
 * observable condition — never a fixed sleep.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestProxy, startTestWsServer, type TestProxy, type TestWsServer } from '@wirebench/engine/test-helpers';
import { WirebenchError, type WsCallInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { WsSendResolution } from '../src/main/ws-send.js';
import type { FailedExchangeWire, HistoryEntryWire, LogEntryWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(
  channel: string,
  payload: unknown,
  sender: unknown = { isDestroyed: () => false, send: () => undefined },
) {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`${channel} was never registered`);
  }
  return handler({ sender }, payload);
}

function unwrap<T>(result: unknown): T {
  const envelope = result as { ok: boolean; value?: T; error?: { code: string; message: string } };
  if (!envelope.ok) {
    throw new Error(`ipc failed: ${envelope.error?.code} ${envelope.error?.message}`);
  }
  return envelope.value as T;
}

/** A fake `WebContents` that just collects every event sent to it, by channel name. */
function fakeSender(): {
  sender: { isDestroyed: () => boolean; send: (channel: string, payload: unknown) => void };
  events: unknown[];
} {
  const events: unknown[] = [];
  return {
    sender: {
      isDestroyed: () => false,
      send: (_channel: string, payload: unknown) => {
        events.push(payload);
      },
    },
    events,
  };
}

/** Waits, with a bounded deadline, until `predicate()` is true — never a fixed sleep. */
async function waitFor(predicate: () => boolean, what: string, timeoutMs = 8000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (!predicate()) {
    if (Date.now() > deadline) {
      throw new Error(`timed out waiting for ${what}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}

/** True once `events` (from {@link fakeSender}) has recorded a `ws.live` event of `kind`. */
function hasKind(events: readonly unknown[], kind: string): boolean {
  return events.some((e) => (e as { kind?: string }).kind === kind);
}

/** Waits until a `ws.live` `handshake` event has arrived on `events`. */
function waitForHandshake(events: readonly unknown[]): Promise<void> {
  return waitFor(() => hasKind(events, 'handshake'), 'the handshake live event');
}

/** Reads `EngineService`'s private `sends` map; test-only, for "the prepare stage has registered". */
function hasSend(service: EngineService, sendId: string): boolean {
  return (service as unknown as { sends: Map<string, unknown> }).sends.has(sendId);
}

let server: TestWsServer;

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

/** A `WsSendResolution` aimed at `path` on the running test server. */
function resolution(
  path: string,
  overrides: {
    readonly headers?: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[];
    readonly query?: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[];
    readonly auth?: WsSendResolution['auth'];
    readonly unresolved?: readonly {
      readonly expr: string;
      readonly name?: string;
      readonly code: 'missing' | 'unknown-scope' | 'cycle' | 'too-deep' | 'malformed';
      readonly start: number;
      readonly end: number;
    }[];
  } = {},
): WsSendResolution {
  const input: WsCallInput = {
    serverUrl: server.url,
    request: {
      url: path,
      query: overrides.query ?? [],
      headers: overrides.headers ?? [{ name: 'Authorization', value: 'Bearer plain-token', enabled: true }],
      subprotocols: [],
      settings: {},
    },
    apiHeaders: [],
  };
  return {
    input,
    unresolved: overrides.unresolved ?? [],
    api: { kind: 'websocket', id: 'w-1', name: 'Chat', slug: 'chat', order: 0, url: server.url, headers: [] },
    request: {
      kind: 'websocket',
      id: 'q-1',
      name: 'Echo',
      slug: 'echo',
      order: 0,
      url: path,
      query: input.request.query,
      headers: input.request.headers,
      subprotocols: [],
      auth: overrides.auth ?? { type: 'none' },
      settings: {},
      messages: [],
    },
    urlSource: 'api',
    auth: overrides.auth ?? { type: 'none' },
  } as unknown as WsSendResolution;
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    preflight: () => undefined as never,
    authFor: () => undefined,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    buildLiveSendInput: () => undefined,
    sendInputFor: () => undefined,
    dumpFileFor: () => undefined,
    wsSend: (requestId: string) => (requestId.startsWith('ws-') ? resolution('/echo') : undefined),
    wsTlsFor: () => Promise.resolve(undefined),
    wsMeta: () => ({ requestName: 'Echo', apiName: 'Chat', folderPath: '' }),
    ...overrides,
  } as unknown as RequestChannelDeps['project'];
}

function register(overrides: Partial<RequestChannelDeps> = {}, projectOverrides: Record<string, unknown> = {}) {
  const service = new EngineService();
  registerRequestChannels(service, {
    project: project(projectOverrides),
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
    getSecret: () => Promise.resolve(undefined),
    ...overrides,
  });
  return service;
}

describe('request.openWs → request.wsSend → request.wsClose', () => {
  beforeEach(() => {
    handlers.clear();
  });

  it('opens a session, echoes a sent message live before the invoke resolves, and closes it', async () => {
    register();
    const { sender, events } = fakeSender();

    const openPromise = invoke('request.openWs', { sendId: 's1', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    const sendReply = unwrap<{ text: string }>(
      await invoke('request.wsSend', { sendId: 's1', requestId: 'ws-1', format: 'text', content: 'hi', expand: false }),
    );
    expect(sendReply.text).toBe('hi');

    await waitFor(
      () =>
        events.some(
          (e) =>
            (e as { kind?: string; frame?: { direction?: string; opcode?: string } }).kind === 'frame' &&
            (e as { frame: { direction: string; opcode: string } }).frame.direction === 'received' &&
            (e as { frame: { direction: string; opcode: string } }).frame.opcode === 'text',
        ),
      'the text echo to arrive live',
    );

    const closeReply = unwrap<{ closed: boolean }>(await invoke('request.wsClose', { sendId: 's1' }));
    expect(closeReply).toEqual({ closed: true });

    const summary = unwrap<{ handshake: { status: number; requestHeaders: Record<string, string> } }>(
      await openPromise,
    );
    expect(summary.handshake.status).toBe(101);

    // Authorization was masked on the wire (no show-secrets flag configured).
    expect(summary.handshake.requestHeaders['Authorization']).toBe('<redacted>');
  });

  it('shows the real Authorization value when the session shows secrets', async () => {
    register({ showSecrets: { get: () => true } });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's2', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);
    unwrap(await invoke('request.wsClose', { sendId: 's2' }));
    const summary = unwrap<{ handshake: { requestHeaders: Record<string, string> } }>(await openPromise);
    expect(summary.handshake.requestHeaders['Authorization']).toBe('Bearer plain-token');
  });

  it('masks an API key configured "in query" everywhere the URL leaves main, and shows it when secrets are shown', async () => {
    // The real value is always resolved and always dialled with — REST masks the *display* of its
    // URL the same way, never the credential the send itself actually uses. The parameter is named
    // something `redactUrl`'s own built-in sensitive-name list would never catch on its own (that
    // list already masks `api_key`), so this actually exercises the `keyParams` plumbing derived
    // from the resolved auth, not the built-in default.
    const withKeyInQuery = (requestId: string) =>
      requestId.startsWith('ws-')
        ? resolution('/echo', {
            auth: { type: 'api-key', name: 'x-custom-cred', in: 'query', valueRef: 'sec_key' } as never,
          })
        : undefined;
    const getSecret = () => Promise.resolve('shh-secret');

    // Hidden (default show-secrets).
    register({ getSecret }, { wsSend: withKeyInQuery });
    const { sender: senderHidden, events: eventsHidden } = fakeSender();
    const openHidden = invoke('request.openWs', { sendId: 'k1', requestId: 'ws-1' }, senderHidden);
    await waitForHandshake(eventsHidden);
    unwrap(await invoke('request.wsClose', { sendId: 'k1' }));
    const summaryHidden = unwrap<{ url: string; handshake: { url: string } }>(await openHidden);
    expect(summaryHidden.url).not.toContain('shh-secret');
    expect(summaryHidden.handshake.url).not.toContain('shh-secret');
    const handshakeEventHidden = eventsHidden.find((e) => (e as { kind?: string }).kind === 'handshake') as {
      handshake: { url: string };
    };
    expect(handshakeEventHidden.handshake.url).not.toContain('shh-secret');

    // Shown.
    register({ showSecrets: { get: () => true }, getSecret }, { wsSend: withKeyInQuery });
    const { sender: senderShown, events: eventsShown } = fakeSender();
    const openShown = invoke('request.openWs', { sendId: 'k2', requestId: 'ws-1' }, senderShown);
    await waitForHandshake(eventsShown);
    unwrap(await invoke('request.wsClose', { sendId: 'k2' }));
    const summaryShown = unwrap<{ url: string; handshake: { url: string } }>(await openShown);
    expect(summaryShown.url).toContain('shh-secret');
    expect(summaryShown.handshake.url).toContain('shh-secret');
    const handshakeEventShown = eventsShown.find((e) => (e as { kind?: string }).kind === 'handshake') as {
      handshake: { url: string };
    };
    expect(handshakeEventShown.handshake.url).toContain('shh-secret');
  });

  it('refuses wsSend with an unresolved ${nope} when expand is true, and the server receives nothing', async () => {
    register();
    const { sender, events } = fakeSender();
    const before = server.received.length;
    const openPromise = invoke('request.openWs', { sendId: 's3', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    const reply = (await invoke('request.wsSend', {
      sendId: 's3',
      requestId: 'ws-1',
      format: 'text',
      content: '${nope}',
      expand: true,
    })) as { ok: boolean; error?: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ws-unresolved-properties');
    expect(server.received.length).toBe(before);

    unwrap(await invoke('request.wsClose', { sendId: 's3' }));
    await openPromise;
  });

  it('refuses wsSend with invalid base64 for a binary message', async () => {
    register();
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's4', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    const reply = (await invoke('request.wsSend', {
      sendId: 's4',
      requestId: 'ws-1',
      format: 'binary',
      content: 'not-base64!!',
      expand: false,
    })) as { ok: boolean; error?: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ws-bad-binary');

    unwrap(await invoke('request.wsClose', { sendId: 's4' }));
    await openPromise;
  });

  it('accepts an empty binary message', async () => {
    register();
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's4b', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    const reply = unwrap<{ opcode: string; size: number }>(
      await invoke('request.wsSend', {
        sendId: 's4b',
        requestId: 'ws-1',
        format: 'binary',
        content: '',
        expand: false,
      }),
    );
    expect(reply.opcode).toBe('binary');
    expect(reply.size).toBe(0);

    unwrap(await invoke('request.wsClose', { sendId: 's4b' }));
    await openPromise;
  });

  it('wsSend for an unknown sendId is refused with ws-session-unknown', async () => {
    register();
    const reply = (await invoke('request.wsSend', {
      sendId: 'never-opened',
      requestId: 'ws-1',
      format: 'text',
      content: 'x',
      expand: false,
    })) as { ok: boolean; error?: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('ws-session-unknown');
  });

  it('an illegal close code is refused with ws-bad-close, and the session is still open and closable with 1000', async () => {
    register();
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's4c', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    const badClose = (await invoke('request.wsClose', { sendId: 's4c', code: 1002 })) as {
      ok: boolean;
      error?: { code: string };
    };
    expect(badClose.ok).toBe(false);
    expect(badClose.error?.code).toBe('ws-bad-close');

    // Still open: an ordinary send still goes through.
    const sendReply = unwrap<{ text: string }>(
      await invoke('request.wsSend', {
        sendId: 's4c',
        requestId: 'ws-1',
        format: 'text',
        content: 'still here',
        expand: false,
      }),
    );
    expect(sendReply.text).toBe('still here');

    const closeReply = unwrap<{ closed: boolean }>(await invoke('request.wsClose', { sendId: 's4c' }));
    expect(closeReply).toEqual({ closed: true });
    await openPromise;
  });

  it('request.cancel aborts a handshake still in flight', async () => {
    const service = register(
      {},
      { wsSend: (requestId: string) => (requestId.startsWith('ws-') ? resolution('/hang') : undefined) },
    );
    const { sender } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's5', requestId: 'ws-1' }, sender);
    await waitFor(() => hasSend(service, 's5'), 'the prepare stage to register the send');
    unwrap(await invoke('request.cancel', { sendId: 's5' }));
    const summary = unwrap<{ closed: { by: string } }>(await openPromise);
    expect(summary.closed.by).toBe('error');
  });

  it('reports a prepare-stage failure when the proxy lookup throws', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    register(
      { onSendFailed },
      { proxyFor: () => Promise.reject(new WirebenchError('proxy-resolve-failed', 'No proxy.')) },
    );
    const { sender } = fakeSender();
    const reply = (await invoke('request.openWs', { sendId: 's6', requestId: 'ws-1' }, sender)) as { ok: boolean };
    expect(reply.ok).toBe(false);
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({
      sendId: 's6',
      protocol: 'websocket',
      stage: 'prepare',
      error: { code: 'proxy-resolve-failed' },
    });
  });

  it('request.curl returns a websocat command line for a WebSocket request', async () => {
    register();
    const reply = unwrap<{ command: string }>(
      await invoke('request.curl', { requestId: 'ws-1', shell: 'posix' as const }),
    );
    expect(reply.command).toContain('websocat');
    expect(reply.command).toContain(`${server.url}/echo`);
  });

  it('the HTTP Log row exists (through onExchange) the moment the handshake settles — before the session closes', async () => {
    const onExchange = vi.fn<(entry: LogEntryWire) => void>();
    register({ onExchange });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's8', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    // Not resolved yet: the log row already exists (assertion below), long before `wsClose`.
    expect(onExchange).toHaveBeenCalledTimes(1);
    const entry = onExchange.mock.calls[0]![0];
    expect(entry.kind).toBe('exchange');
    if (entry.kind !== 'exchange') throw new Error('unreachable');
    expect(entry.requestId).toBe('ws-1');
    expect(entry.exchange).toMatchObject({ protocol: 'websocket', method: 'GET', status: 101 });
    expect((entry.exchange as { url: string }).url).toMatch(/^http:\/\//);
    expect((entry.exchange as { wsUrl: string }).wsUrl).toMatch(/^ws:\/\//);

    unwrap(await invoke('request.wsClose', { sendId: 's8' }));
    await openPromise;
  });

  it('the successful log row masks a secret header and an API-key query parameter when secrets are hidden', async () => {
    const onExchange = vi.fn<(entry: LogEntryWire) => void>();
    const withKeyInQuery = (requestId: string) =>
      requestId.startsWith('ws-')
        ? resolution('/echo', {
            auth: { type: 'api-key', name: 'x-custom-cred', in: 'query', valueRef: 'sec_key' } as never,
          })
        : undefined;
    register({ onExchange, getSecret: () => Promise.resolve('shh-secret') }, { wsSend: withKeyInQuery });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's8b', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);
    unwrap(await invoke('request.wsClose', { sendId: 's8b' }));
    await openPromise;

    expect(onExchange).toHaveBeenCalledTimes(1);
    const entry = onExchange.mock.calls[0]![0];
    if (entry.kind !== 'exchange') throw new Error('unreachable');
    const exchange = entry.exchange as { url: string; wsUrl: string; requestHeaders: Record<string, string> };
    expect(exchange.requestHeaders['Authorization']).toBe('<redacted>');
    expect(exchange.url).not.toContain('shh-secret');
    expect(exchange.wsUrl).not.toContain('shh-secret');
  });

  it('writes one History entry on close, through wsMeta and the resolved request/api names', async () => {
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(() =>
      Promise.resolve({ id: 'h1', kind: 'websocket' } as HistoryEntryWire),
    );
    const onHistoryAppended = vi.fn<(entry: HistoryEntryWire) => void>();
    register({ history: { recordWsSession } as never, onHistoryAppended });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's9', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);
    unwrap(await invoke('request.wsClose', { sendId: 's9' }));
    await openPromise;

    expect(recordWsSession).toHaveBeenCalledTimes(1);
    const [projectId, record] = recordWsSession.mock.calls[0]!;
    expect(projectId).toBe('p1');
    expect(record).toMatchObject({ requestId: 'ws-1', requestName: 'Echo', apiName: 'Chat', folderPath: '' });
    expect(onHistoryAppended).toHaveBeenCalledWith({ id: 'h1', kind: 'websocket' });
  });

  it('a refused handshake (401) produces both a failed log row and a History entry with closedBy: error', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const onExchange = vi.fn<(entry: LogEntryWire) => void>();
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(() =>
      Promise.resolve({ id: 'h2', kind: 'websocket' } as HistoryEntryWire),
    );
    register(
      { onSendFailed, onExchange, history: { recordWsSession } as never },
      { wsSend: (requestId: string) => (requestId.startsWith('ws-') ? resolution('/refuse') : undefined) },
    );
    const { sender } = fakeSender();
    const summary = unwrap<{ closed: { by: string } }>(
      await invoke('request.openWs', { sendId: 's10', requestId: 'ws-1' }, sender),
    );
    expect(summary.closed.by).toBe('error');

    expect(onExchange).not.toHaveBeenCalled();
    expect(onSendFailed).toHaveBeenCalledTimes(1);
    expect(onSendFailed.mock.calls[0]![0]).toMatchObject({ protocol: 'websocket' });

    expect(recordWsSession).toHaveBeenCalledTimes(1);
    const record = recordWsSession.mock.calls[0]![1] as { exchange: { closed: { by: string } } };
    expect(record.exchange.closed.by).toBe('error');
  });

  it('request.preflightWs returns the resolved URL, its source and unresolved expressions, without dialling', async () => {
    register(
      {},
      {
        wsSend: (requestId: string) =>
          requestId.startsWith('ws-')
            ? resolution('/echo', {
                unresolved: [{ expr: '${nope}', name: 'nope', code: 'missing', start: 0, end: 7 }],
              })
            : undefined,
      },
    );
    const before = server.received.length;
    const handshakesBefore = server.handshakes.length;
    const reply = unwrap<{
      endpoint: string;
      endpointSource: string;
      unresolved: readonly { expr: string }[];
    }>(await invoke('request.preflightWs', { requestId: 'ws-1' }));
    expect(reply.endpoint).toBe(`${server.url}/echo`);
    expect(reply.endpointSource).toBe('interface-default');
    expect(reply.unresolved.map((ref) => ref.expr)).toEqual(['${nope}']);
    // Nothing was sent, and no connection was attempted.
    expect(server.received.length).toBe(before);
    expect(server.handshakes.length).toBe(handshakesBefore);
  });
});

describe('request.openWs through a proxy', () => {
  let proxy: TestProxy;

  beforeEach(() => {
    handlers.clear();
  });

  afterEach(async () => {
    await proxy?.close();
  });

  it('dials through the proxy `proxyFor` returns, recorded as a CONNECT tunnel', async () => {
    proxy = await startTestProxy();
    register({}, { proxyFor: () => Promise.resolve({ url: proxy.url }) });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's7', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);
    unwrap(await invoke('request.wsClose', { sendId: 's7' }));
    const summary = unwrap<{ handshake: { status: number } }>(await openPromise);
    expect(summary.handshake.status).toBe(101);
    expect(proxy.tunnelCount()).toBeGreaterThan(0);
  });
});
