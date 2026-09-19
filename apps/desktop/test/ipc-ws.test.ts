// @vitest-environment node
/**
 * The three WebSocket channels end to end: `request.openWs` against a real server, driven by
 * `request.wsSend`/`request.wsClose`, with `ws.live` events collected on a fake sender, plus the
 * prepare-stage failure row, the proxy path, `request.curl` and `request.cancel`.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { startTestProxy, startTestWsServer, type TestProxy, type TestWsServer } from '@wirebench/engine/test-helpers';
import { WirebenchError, type WsCallInput } from '@wirebench/engine';
import { EngineService } from '../src/main/engine-service.js';
import { registerRequestChannels, type RequestChannelDeps } from '../src/main/ipc/request.js';
import type { WsSendResolution } from '../src/main/ws-send.js';
import type { FailedExchangeWire } from '../src/shared/wire-types.js';

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
    readonly unresolved?: readonly { readonly expr: string; readonly name?: string }[];
  } = {},
): WsSendResolution {
  const input: WsCallInput = {
    serverUrl: server.url,
    request: {
      url: path,
      query: [],
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
      query: [],
      headers: input.request.headers,
      subprotocols: [],
      auth: { type: 'none' },
      settings: {},
      messages: [],
    },
    urlSource: 'api',
    auth: { type: 'none' },
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

    // Wait for the handshake live event before sending.
    const deadline = Date.now() + 5000;
    while (!events.some((e) => (e as { kind?: string }).kind === 'handshake') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    expect(events.some((e) => (e as { kind?: string }).kind === 'handshake')).toBe(true);

    const sendReply = unwrap<{ text: string }>(
      await invoke('request.wsSend', { sendId: 's1', requestId: 'ws-1', format: 'text', content: 'hi', expand: false }),
    );
    expect(sendReply.text).toBe('hi');

    while (
      !events.some(
        (e) =>
          (e as { opcode?: string; direction?: string }).opcode === 'text' &&
          (e as { direction?: string }).direction === 'received',
      ) &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 5));
    }

    const closeReply = unwrap<{ closed: boolean }>(await invoke('request.wsClose', { sendId: 's1' }));
    expect(closeReply).toEqual({ closed: true });

    const summary = unwrap<{ handshake: { status: number; requestHeaders: Record<string, string> } }>(
      await openPromise,
    );
    expect(summary.handshake.status).toBe(101);

    // Authorization was masked on the wire (no show-secrets flag configured).
    expect(summary.handshake.requestHeaders['Authorization']).toBe('<redacted>');
  }, 15000);

  it('shows the real Authorization value when the session shows secrets', async () => {
    register({ showSecrets: { get: () => true } });
    const { sender, events } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's2', requestId: 'ws-1' }, sender);
    const deadline = Date.now() + 8000;
    while (!events.some((e) => (e as { kind?: string }).kind === 'handshake') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    unwrap(await invoke('request.wsClose', { sendId: 's2' }));
    const summary = unwrap<{ handshake: { requestHeaders: Record<string, string> } }>(await openPromise);
    expect(summary.handshake.requestHeaders['Authorization']).toBe('Bearer plain-token');
  }, 15000);

  it('refuses wsSend with an unresolved ${nope} when expand is true, and the server receives nothing', async () => {
    register();
    const { sender } = fakeSender();
    const before = server.received.length;
    const openPromise = invoke('request.openWs', { sendId: 's3', requestId: 'ws-1' }, sender);
    await new Promise((r) => setTimeout(r, 100));

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
    const { sender } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's4', requestId: 'ws-1' }, sender);
    await new Promise((r) => setTimeout(r, 100));

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

  it('request.cancel aborts a handshake still in flight', async () => {
    register({}, { wsSend: (requestId: string) => (requestId.startsWith('ws-') ? resolution('/hang') : undefined) });
    const { sender } = fakeSender();
    const openPromise = invoke('request.openWs', { sendId: 's5', requestId: 'ws-1' }, sender);
    await new Promise((r) => setTimeout(r, 50));
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
    const deadline = Date.now() + 8000;
    while (!events.some((e) => (e as { kind?: string }).kind === 'handshake') && Date.now() < deadline) {
      await new Promise((r) => setTimeout(r, 5));
    }
    unwrap(await invoke('request.wsClose', { sendId: 's7' }));
    const summary = unwrap<{ handshake: { status: number } }>(await openPromise);
    expect(summary.handshake.status).toBe(101);
    expect(proxy.tunnelCount()).toBeGreaterThan(0);
  }, 15000);
});
