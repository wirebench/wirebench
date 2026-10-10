// @vitest-environment node
/**
 * The three WebSocket channels end to end: `request.openWs` against a real server, through the
 * engine, driven by `request.wsSend`/`request.wsClose`, with `ws.live` events collected on a fake
 * sender, plus the prepare-stage failure row, the URL-masking of an API key configured "in query",
 * the proxy path, `request.preflightWs`, `request.curl`, `request.cancel` and the registry's
 * closing of a project's sessions. Every wait is a bounded poll on an observable condition — never
 * a fixed sleep.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestProxy, startTestWsServer, type TestProxy, type TestWsServer } from '@wirebench/engine/test-helpers';
import {
  createProject,
  createWsApi,
  createWsRequest,
  entry,
  WirebenchError,
  type AuthConfig,
  type Project,
} from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, whenWsSessionsRecorded, type RequestChannelDeps } from '../src/main/ipc/request.js';
import { ExchangeRegistry } from '../src/main/send/exchange.js';
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

let server: TestWsServer;

beforeAll(async () => {
  server = await startTestWsServer();
});

afterAll(async () => {
  await server.close();
});

/**
 * A project whose WebSocket requests `ws-1` and `ws-2` dial `path` on the running test server, with an
 * `Authorization` header unless `overrides` gives other headers.
 */
function model(
  path: string,
  overrides: {
    readonly headers?: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[];
    readonly query?: readonly { readonly name: string; readonly value: string; readonly enabled: boolean }[];
    readonly auth?: AuthConfig;
  } = {},
): Project {
  const request = (id: string, name: string) =>
    createWsRequest(name, {
      id,
      url: path,
      query: [...(overrides.query ?? [])],
      headers: [...(overrides.headers ?? [entry('Authorization', 'Bearer plain-token')])],
      auth: overrides.auth ?? { type: 'none' },
    });
  return {
    ...createProject('Demo', { id: 'p1' }),
    containers: {
      websocket: [
        createWsApi('Chat', {
          id: 'w-1',
          url: server.url,
          requests: [request('ws-1', 'Echo'), request('ws-2', 'Echo 2')],
        }),
      ],
    },
  };
}

/** The project stub's `runContextFor` over {@link model}: every `ws-` id is one of its requests. */
function locatedAt(path: string, overrides: Parameters<typeof model>[1] = {}) {
  const project = model(path, overrides);
  return (requestId: string) => (requestId.startsWith('ws-') ? { project, projectDir: '/tmp/none' } : undefined);
}

function project(overrides: Record<string, unknown> = {}) {
  return {
    scopesFor: () => ({ project: {}, global: {}, system: {} }),
    preflight: () => undefined as never,
    requestMeta: () => undefined,
    projectId: () => 'p1',
    requestSource: () => undefined as never,
    dumpFileFor: () => undefined,
    runContextFor: locatedAt('/echo'),
    wsMeta: () => ({ requestName: 'Echo', apiName: 'Chat', folderPath: '' }),
    ...overrides,
  } as unknown as RequestChannelDeps['project'];
}

/** Registers the channels; answers the registry they keep their sessions in. */
function register(overrides: Partial<RequestChannelDeps> = {}, projectOverrides: Record<string, unknown> = {}) {
  const registry = new ExchangeRegistry();
  registerRequestChannels(new EngineService(), {
    project: project(projectOverrides),
    adHocScopes: () => ({ project: {}, global: {}, system: {} }),
    getSecret: () => Promise.resolve(undefined),
    registry,
    ...overrides,
  });
  return registry;
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
    const withKeyInQuery = locatedAt('/echo', {
      auth: { type: 'api-key', name: 'x-custom-cred', in: 'query', valueRef: 'sec_key' } as never,
    });
    const getSecret = () => Promise.resolve('shh-secret');

    // Hidden (default show-secrets).
    register({ getSecret }, { runContextFor: withKeyInQuery });
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
    register({ showSecrets: { get: () => true }, getSecret }, { runContextFor: withKeyInQuery });
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
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(() =>
      Promise.resolve({ id: 'h-cancel', kind: 'websocket' } as HistoryEntryWire),
    );
    const registry = register({ history: { recordWsSession } as never }, { runContextFor: locatedAt('/hang') });
    const { sender } = fakeSender();
    const before = server.handshakes.length;
    const openPromise = invoke('request.openWs', { sendId: 's5', requestId: 'ws-1' }, sender);
    await waitFor(() => server.handshakes.length > before, 'the upgrade to reach the server');
    expect(registry.has('s5')).toBe(true);
    unwrap(await invoke('request.cancel', { sendId: 's5' }));
    // The engine fails a session cancelled before its handshake, where the old path answered with
    // its transcript closed by `error`.
    const reply = (await openPromise) as { ok: boolean; error?: { code: string } };
    expect(reply.ok).toBe(false);
    expect(reply.error?.code).toBe('aborted');
    // History keeps the attempt, as it always has: a session that never opened, closed by error.
    expect(recordWsSession).toHaveBeenCalledTimes(1);
    expect(recordWsSession.mock.calls[0]![1]).toMatchObject({
      requestId: 'ws-1',
      handshakeOpened: false,
      exchange: { closed: { by: 'error' } },
    });
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

  it.each([false, true])(
    'request.curl notes Kerberos with show-secrets %s, and reads no secret for it',
    async (shown) => {
      const read: string[] = [];
      const getSecret = (ref: string) => {
        read.push(ref);
        return Promise.resolve('pw');
      };
      const kerberos = locatedAt('/echo', {
        auth: { type: 'kerberos', username: 'alice', domain: 'CORP', passwordRef: 'sec_pw' } as never,
      });
      register({ getSecret, showSecrets: { get: () => shown } }, { runContextFor: kerberos });
      const reply = unwrap<{ command: string; notes: string[] }>(
        await invoke('request.curl', { requestId: 'ws-1', shell: 'posix' as const }),
      );
      expect(reply.notes).toContain(
        'Kerberos is not expressible in this command; the upgrade is shown without authorization.',
      );
      expect(read).toEqual([]);
    },
  );

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
    const withKeyInQuery = locatedAt('/echo', {
      auth: { type: 'api-key', name: 'x-custom-cred', in: 'query', valueRef: 'sec_key' } as never,
    });
    register({ onExchange, getSecret: () => Promise.resolve('shh-secret') }, { runContextFor: withKeyInQuery });
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

  it('a session closed by the app still records its History entry before the wait resolves', async () => {
    // The shutdown path in `main/index.ts`: ask every socket to close, then wait for each pending
    // `request.openWs` to have written its entry. Quitting (or closing the project) before that
    // wait would drop the entry — the history file closes with the project, and the process with
    // the app.
    let recorded = false;
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(async () => {
      // A real record writes to disk; the wait must outlast that, not just the socket closing.
      await new Promise((resolve) => setImmediate(resolve));
      recorded = true;
      return { id: 'h-quit', kind: 'websocket' } as HistoryEntryWire;
    });
    const registry = register({ history: { recordWsSession } as never });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 'quit-1', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    expect(registry.endWhere(() => true, 'websocket')).toBe(1);
    expect(recorded).toBe(false);
    await whenWsSessionsRecorded(8000);

    expect(recorded).toBe(true);
    expect(recordWsSession).toHaveBeenCalledTimes(1);
    await openPromise;
  });

  it('waits for a session that already closed but whose History write is still in flight', async () => {
    // The engine drops a session from its map as the socket finishes, before the pending
    // `request.openWs` has written the entry. So "nothing is open" says nothing about "everything
    // is recorded", and the shutdown wait must not be skipped on the strength of it.
    let recorded = false;
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(async () => {
      await new Promise((resolve) => setImmediate(resolve));
      recorded = true;
      return { id: 'h-late', kind: 'websocket' } as HistoryEntryWire;
    });
    const registry = register({ history: { recordWsSession } as never });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 'late-1', requestId: 'ws-1' }, sender);
    await waitForHandshake(events);

    // The user disconnected a moment before the quit: the socket is closing, so the registry has
    // nothing left to close — but the entry has not been written yet.
    unwrap(await invoke('request.wsClose', { sendId: 'late-1' }));
    expect(registry.endWhere(() => true, 'websocket')).toBe(0);
    expect(recorded).toBe(false);

    await whenWsSessionsRecorded(8000);

    expect(recorded).toBe(true);
    await openPromise;
  });

  it('closes only the sessions of the project being closed, and waits for those', async () => {
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(() =>
      Promise.resolve({ id: 'h-close', kind: 'websocket' } as HistoryEntryWire),
    );
    // Two sessions, one per project, exactly as `closeWsSessions(projectId)` sees them.
    const owners: Record<string, string> = { 'ws-1': 'p1', 'ws-2': 'p2' };
    const registry = register({ history: { recordWsSession } as never }, { projectId: (id: string) => owners[id] });
    const first = fakeSender();
    const second = fakeSender();
    const openOne = invoke('request.openWs', { sendId: 'c-1', requestId: 'ws-1' }, first.sender);
    const openTwo = invoke('request.openWs', { sendId: 'c-2', requestId: 'ws-2' }, second.sender);
    await waitForHandshake(first.events);
    await waitForHandshake(second.events);

    expect(registry.endWhere((requestId) => owners[requestId] === 'p1', 'websocket')).toBe(1);
    await whenWsSessionsRecorded(8000, (requestId) => owners[requestId] === 'p1');

    // The other project's session is untouched: its invoke is still pending.
    expect(recordWsSession).toHaveBeenCalledTimes(1);
    expect(recordWsSession.mock.calls[0]![0]).toBe('p1');
    await openOne;

    unwrap(await invoke('request.wsClose', { sendId: 'c-2' }));
    await openTwo;
  });

  it('a refused handshake (401) produces both a failed log row and a History entry with closedBy: error', async () => {
    const onSendFailed = vi.fn<(failure: FailedExchangeWire) => void>();
    const onExchange = vi.fn<(entry: LogEntryWire) => void>();
    const recordWsSession = vi.fn<(...args: unknown[]) => Promise<HistoryEntryWire>>(() =>
      Promise.resolve({ id: 'h2', kind: 'websocket' } as HistoryEntryWire),
    );
    register(
      { onSendFailed, onExchange, history: { recordWsSession } as never },
      { runContextFor: locatedAt('/refuse') },
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
    register({}, { runContextFor: locatedAt('/echo', { headers: [entry('X-Who', '${nope}')] }) });
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
