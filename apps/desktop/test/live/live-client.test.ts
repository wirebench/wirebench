// @vitest-environment node
/**
 * `LiveClient` against the engine's test WebSocket server (live-updates spec §3.4, §11): the
 * capability check, the token in `auth` only, subscribe after `ready`, back-off and its reset,
 * `4429`, the `ready` and `pong` deadlines, `4401`, presence without self, unknown types, and the
 * `1000` close on the last unsubscribe. The socket is real; every timer the client arms goes
 * through a queue fired by hand, so nothing here waits on the clock.
 */
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { connectWebSocket, LIVE_PATH, type ConnectedWebSocket } from '@wirebench/engine';
import { startTestWsServer, type TestWsServer } from '@wirebench/engine/test-helpers';
import { backoffMs, LiveClient, liveUrl, type LiveEvent, type LiveState } from '../../src/main/live/live-client.js';
import { Inbox, manualTimers } from './live-test-helpers.js';

const WS_A = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const WS_B = '01J8ZC5Q0V7R3T9XK2M4N6P8QD';
const SELF = '01J8ZC5Q0V7R3T9XK2M4N6P8S1';
const ANA = '01J8ZC5Q0V7R3T9XK2M4N6P8S2';
const BEN = '01J8ZC5Q0V7R3T9XK2M4N6P8S3';
const TOKEN = `wbs_${'A'.repeat(43)}`;
const NEW_TOKEN = `wbs_${'B'.repeat(43)}`;
const HEAD = 'b'.repeat(40);

type Peer = TestWsServer['peers'][number];
type Socket = ConnectedWebSocket['socket'];
interface Received {
  readonly message: { readonly type: string } & Readonly<Record<string, unknown>>;
  readonly peer: Peer;
}

let server: TestWsServer;
let inbox: Inbox<Received>;
const clients: LiveClient[] = [];

beforeAll(async () => {
  server = await startTestWsServer({
    onText: (text, peer) => inbox.push({ message: JSON.parse(text) as Received['message'], peer }),
  });
});

beforeEach(() => {
  inbox = new Inbox();
});

afterEach(async () => {
  await Promise.all(clients.splice(0).map((client) => client.close()));
});

afterAll(async () => {
  await server.close();
});

/** The next message of `type` the server received, with the peer that sent it. */
const next = (type: string): Promise<Received> => inbox.take((received) => received.message.type === type);
const reply = (peer: Peer, message: object): void => peer.sendText(JSON.stringify(message));

/** Waits for `auth`, answers `ready`, and returns the peer. */
async function accept(): Promise<Peer> {
  const { peer } = await next('auth');
  reply(peer, { type: 'ready' });
  return peer;
}

/** The code of the socket's close event; call it before the close starts. */
const closeCode = (socket: Socket): Promise<number> =>
  new Promise((resolve) => {
    socket.addEventListener('close', (event) => resolve(event.code), { once: true });
  });

function recorder(): {
  readonly events: readonly LiveEvent[];
  readonly inbox: Inbox<LiveEvent>;
  readonly listener: (event: LiveEvent) => void;
} {
  const box = new Inbox<LiveEvent>();
  return { events: box.all, inbox: box, listener: (event) => box.push(event) };
}

const isState =
  (state: LiveState) =>
  (event: LiveEvent): boolean =>
    event.kind === 'state' && event.state === state;
const isMessage =
  (type: string) =>
  (event: LiveEvent): boolean =>
    event.kind === 'message' && event.message.type === type;

function makeClient(options: { readonly capabilities?: readonly string[]; readonly url?: string } = {}) {
  const timers = manualTimers();
  const sockets: Socket[] = [];
  const tokenFor = vi.fn((): Promise<string | undefined> => Promise.resolve(TOKEN));
  const refresh = vi.fn((): Promise<void> => Promise.resolve());
  const meta = vi.fn(() => Promise.resolve({ capabilities: options.capabilities ?? ['sync', 'live'] }));
  const log = vi.fn<(message: string) => void>();
  const client = new LiveClient({
    url: options.url ?? `http://127.0.0.1:${server.port}`,
    connect: (wsUrl) => {
      const opened = connectWebSocket(wsUrl);
      sockets.push(opened.socket);
      return opened;
    },
    tokenFor,
    refresh,
    meta,
    userId: () => SELF,
    setTimer: timers.setTimer,
    random: () => 1,
    log,
  });
  clients.push(client);
  return { client, timers, sockets, tokenFor, refresh, meta, log };
}

/** mulberry32: a seeded generator, so the jitter bounds are checked on a repeatable spread. */
function seeded(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4_294_967_296;
  };
}

describe('liveUrl and backoffMs (live-updates §3.4)', () => {
  it('puts the live path on the stored origin and never downgrades TLS', () => {
    expect(liveUrl('https://wb.test')).toBe(`wss://wb.test${LIVE_PATH}`);
    expect(liveUrl('https://wb.test:8443')).toBe('wss://wb.test:8443/api/v1/live');
    expect(liveUrl('http://127.0.0.1:8080')).toBe('ws://127.0.0.1:8080/api/v1/live');
    let caught: unknown;
    try {
      liveUrl('ftp://wb.test');
    } catch (error) {
      caught = error;
    }
    expect(caught).toMatchObject({ code: 'server-url-invalid' });
  });

  it('doubles from one second to a sixty-second ceiling, jittered into [0.5, 1] of it', () => {
    expect([0, 1, 2, 5, 6, 7, 40].map((attempt) => backoffMs(attempt, () => 1))).toEqual([
      1000, 2000, 4000, 32_000, 60_000, 60_000, 60_000,
    ]);
    expect([0, 1, 6].map((attempt) => backoffMs(attempt, () => 0))).toEqual([500, 1000, 30_000]);
    const random = seeded(74);
    for (let attempt = 0; attempt < 12; attempt += 1) {
      const ceiling = Math.min(60_000, 1000 * 2 ** attempt);
      for (let draw = 0; draw < 200; draw += 1) {
        const ms = backoffMs(attempt, random);
        expect(ms).toBeGreaterThanOrEqual(ceiling / 2);
        expect(ms).toBeLessThanOrEqual(ceiling);
      }
    }
  });
});

describe('LiveClient (live-updates §3.4)', () => {
  it('makes no attempt when the server does not offer live, and reports off', async () => {
    const before = server.handshakes.length;
    const { client, meta, tokenFor, timers } = makeClient({ capabilities: ['sync'] });
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    await a.inbox.take(isState('off'));
    expect(a.events).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'off' },
    ]);
    expect(meta).toHaveBeenCalledTimes(1);
    expect(tokenFor).not.toHaveBeenCalled();
    expect(server.handshakes).toHaveLength(before);
    expect(timers.live()).toEqual([]);
  });

  it('makes no attempt for a signed-out account, and reports off', async () => {
    const before = server.handshakes.length;
    const { client, tokenFor, timers } = makeClient();
    tokenFor.mockResolvedValue(undefined);
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    await a.inbox.take(isState('off'));
    expect(server.handshakes).toHaveLength(before);
    expect(timers.live()).toEqual([]);
  });

  it('sends the token only in auth, subscribes on ready, then reports connected', async () => {
    const { client } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const { message: auth, peer } = await next('auth');
    expect(auth).toEqual({ type: 'auth', token: TOKEN });
    const handshake = server.handshakes.at(-1);
    expect(handshake?.url).toBe(LIVE_PATH);
    expect(handshake?.headers['authorization']).toBeUndefined();
    expect(handshake?.headers['origin']).toBeUndefined();
    expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
    reply(peer, { type: 'ready' });
    expect((await next('subscribe')).message).toEqual({ type: 'subscribe', workspaceId: WS_A });
    await a.inbox.take(isState('connected'));
    expect(inbox.all.map((received) => received.message.type)).toEqual(['auth', 'subscribe']);
    expect(client.state).toBe('connected');
  });

  it('routes each message to its workspace, drops self from presence, and ignores what it does not know', async () => {
    const { client } = makeClient();
    const a = recorder();
    const b = recorder();
    client.subscribe(WS_A, a.listener);
    client.subscribe(WS_B, b.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    peer.sendText('not json');
    reply(peer, { type: 'typing', workspaceId: WS_A }); // a type from a newer server
    reply(peer, {
      type: 'presence',
      workspaceId: WS_A,
      users: [
        { id: ANA, name: 'Ana' },
        { id: SELF, name: 'Me' },
        { id: BEN, name: 'Ben' },
      ],
    });
    reply(peer, { type: 'head', workspaceId: WS_B, head: HEAD });
    reply(peer, { type: 'access', workspaceId: WS_A });
    await a.inbox.take(isMessage('access'));
    await b.inbox.take(isMessage('head'));
    expect(a.events.filter((event) => event.kind === 'message')).toEqual([
      {
        kind: 'message',
        message: {
          type: 'presence',
          workspaceId: WS_A,
          users: [
            { id: ANA, name: 'Ana' },
            { id: BEN, name: 'Ben' },
          ],
        },
      },
      { kind: 'message', message: { type: 'access', workspaceId: WS_A } },
    ]);
    expect(b.events.filter((event) => event.kind === 'message')).toEqual([
      { kind: 'message', message: { type: 'head', workspaceId: WS_B, head: HEAD } },
    ]);
    expect(client.state).toBe('connected');
  });

  it('catches a second listener up with the state and the last presence, without a second subscribe', async () => {
    const { client } = makeClient();
    const first = recorder();
    client.subscribe(WS_A, first.listener);
    const peer = await accept();
    await next('subscribe');
    reply(peer, { type: 'presence', workspaceId: WS_A, users: [{ id: ANA, name: 'Ana' }] });
    await first.inbox.take(isMessage('presence'));
    const late = recorder();
    client.subscribe(WS_A, late.listener);
    expect(late.events).toEqual([]); // never called from inside subscribe
    await late.inbox.take(isMessage('presence'));
    expect(late.events).toEqual([
      { kind: 'state', state: 'connected' },
      { kind: 'message', message: { type: 'presence', workspaceId: WS_A, users: [{ id: ANA, name: 'Ana' }] } },
    ]);
    expect(inbox.all.filter((received) => received.message.type === 'subscribe')).toHaveLength(1);
  });

  it('forwards refused to that workspace only, stays connected, and logs too-many once', async () => {
    const { client, log } = makeClient();
    const a = recorder();
    const b = recorder();
    client.subscribe(WS_A, a.listener);
    client.subscribe(WS_B, b.listener);
    const peer = await accept();
    await b.inbox.take(isState('connected'));
    const refused = { type: 'refused', workspaceId: WS_B, code: 'live-too-many-subscriptions' };
    reply(peer, refused);
    reply(peer, refused);
    reply(peer, { type: 'refused', workspaceId: WS_A, code: 'teams-workspace-not-found' });
    await a.inbox.take(isMessage('refused'));
    expect(b.events).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'connected' },
      { kind: 'message', message: refused },
      { kind: 'message', message: refused },
    ]);
    expect(a.events.at(-1)).toEqual({
      kind: 'message',
      message: { type: 'refused', workspaceId: WS_A, code: 'teams-workspace-not-found' },
    });
    expect(client.state).toBe('connected');
    expect(log.mock.calls.filter(([message]) => message.includes('too many'))).toHaveLength(1);
  });

  it('ignores a known type that is malformed, and keeps going', async () => {
    const { client } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    reply(peer, { type: 'head', workspaceId: 'not-an-id', head: HEAD });
    reply(peer, { type: 'presence', workspaceId: WS_A });
    reply(peer, { type: 'access', workspaceId: WS_A });
    await a.inbox.take(isMessage('access'));
    expect(a.events.filter((event) => event.kind === 'message')).toEqual([
      { kind: 'message', message: { type: 'access', workspaceId: WS_A } },
    ]);
  });

  it('subscribes and unsubscribes on the open socket, and closes 1000 on the last unsubscribe', async () => {
    const { client, sockets, timers } = makeClient();
    const a = recorder();
    const offA = client.subscribe(WS_A, a.listener);
    await accept();
    await next('subscribe');
    await a.inbox.take(isState('connected'));
    const offB = client.subscribe(WS_B, () => undefined);
    expect((await next('subscribe')).message).toEqual({ type: 'subscribe', workspaceId: WS_B });
    offB();
    expect((await next('unsubscribe')).message).toEqual({ type: 'unsubscribe', workspaceId: WS_B });
    const socket = sockets[0] as Socket;
    const closed = closeCode(socket);
    offA();
    expect(await closed).toBe(1000);
    expect(inbox.all.map((received) => received.message.type)).toEqual([
      'auth',
      'subscribe',
      'subscribe',
      'unsubscribe',
    ]);
    expect(client.state).toBe('off');
    expect(timers.live()).toEqual([]);
    expect(sockets).toHaveLength(1);
  });

  it('backs off 1 s, 2 s and 4 s while it cannot get in, and starts again at 1 s after a pong', async () => {
    const { client, timers } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    let { peer } = await next('auth');
    peer.close(4408);
    timers.fire(await timers.armed(1000));
    ({ peer } = await next('auth'));
    peer.close(1011);
    timers.fire(await timers.armed(2000));
    ({ peer } = await next('auth'));
    peer.close(4400);
    timers.fire(await timers.armed(4000));
    peer = await accept();
    await a.inbox.take(isState('connected'));
    // The connection has to stay up a heartbeat before the back-off starts over.
    timers.fire(await timers.armed(30_000));
    await next('ping');
    reply(peer, { type: 'pong' });
    await timers.armed(30_000);
    peer.close(1001);
    await a.inbox.take(isState('connecting'));
    await timers.armed(1000);
    expect(timers.live()).toEqual([1000]);
    expect(a.events).toEqual([
      { kind: 'state', state: 'connecting' },
      { kind: 'state', state: 'connected' },
      { kind: 'state', state: 'connecting' },
    ]);
  });

  it('keeps growing the back-off when a server says ready and then drops the socket at once', async () => {
    const { client, timers } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    let peer = await accept();
    await a.inbox.take(isState('connected'));
    peer.close(1011);
    timers.fire(await timers.armed(1000));
    peer = await accept();
    await a.inbox.take(isState('connected'));
    peer.close(1011);
    await timers.armed(2000);
    expect(timers.live()).toEqual([2000]);
  });

  it('waits sixty seconds after 4429', async () => {
    const { client, timers } = makeClient();
    client.subscribe(WS_A, () => undefined);
    const { peer } = await next('auth');
    peer.close(4429);
    await timers.armed(60_000);
    expect(timers.live()).toEqual([60_000]);
  });

  it('backs off when meta cannot be reached, then tries again', async () => {
    const { client, meta, timers } = makeClient();
    meta.mockRejectedValueOnce(new Error('offline'));
    client.subscribe(WS_A, () => undefined);
    timers.fire(await timers.armed(1000));
    expect((await next('auth')).message).toEqual({ type: 'auth', token: TOKEN });
    expect(meta).toHaveBeenCalledTimes(2);
  });

  it('closes and backs off when ready does not come within 10 s', async () => {
    const { client, timers, sockets } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const first = await next('auth');
    const closed = closeCode(sockets[0] as Socket);
    timers.fire(await timers.armed(10_000));
    expect(await closed).toBe(1000);
    timers.fire(await timers.armed(1000));
    const second = await next('auth');
    expect(second.peer).not.toBe(first.peer);
    expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
  });

  it('pings every 30 s, and a pong missing for 10 s reconnects', async () => {
    const { client, timers, sockets } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    expect(timers.live()).toEqual([30_000]);
    timers.fire(await timers.armed(30_000));
    await next('ping');
    expect(timers.live()).toEqual([10_000]);
    reply(peer, { type: 'pong' });
    timers.fire(await timers.armed(30_000));
    await next('ping');
    const closed = closeCode(sockets[0] as Socket);
    timers.fire(await timers.armed(10_000));
    expect(await closed).toBe(1000);
    await a.inbox.take(isState('connecting'));
    timers.fire(await timers.armed(1000));
    await next('auth');
    expect(sockets).toHaveLength(2);
  });

  it('on 4401 runs the token check, reports ended, and waits for reconnect with a new token', async () => {
    const { client, timers, refresh, tokenFor } = makeClient();
    let stateDuringCheck: LiveState | undefined;
    refresh.mockImplementation(() => {
      stateDuringCheck = client.state;
      return Promise.resolve();
    });
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    const peer = await accept();
    await a.inbox.take(isState('connected'));
    reply(peer, { type: 'session-ended' });
    peer.close(4401);
    await a.inbox.take(isState('ended'));
    expect(refresh).toHaveBeenCalledTimes(1);
    expect(stateDuringCheck).toBe('connected');
    expect(client.state).toBe('ended');
    expect(timers.live()).toEqual([]);
    expect(tokenFor).toHaveBeenCalledTimes(1);
    tokenFor.mockResolvedValue(NEW_TOKEN);
    client.reconnect();
    expect((await next('auth')).message).toEqual({ type: 'auth', token: NEW_TOKEN });
  });

  it('close() closes 1000 and nothing reconnects, even for a later subscribe', async () => {
    const { client, sockets, timers } = makeClient();
    const a = recorder();
    client.subscribe(WS_A, a.listener);
    await accept();
    await a.inbox.take(isState('connected'));
    const closed = closeCode(sockets[0] as Socket);
    await client.close();
    expect(await closed).toBe(1000);
    expect(a.events.at(-1)).toEqual({ kind: 'state', state: 'off' });
    expect(timers.live()).toEqual([]);
    const b = recorder();
    client.subscribe(WS_B, b.listener);
    await b.inbox.take(isState('off'));
    expect(sockets).toHaveLength(1);
  });

  it('treats an upgrade answered 404 like any refused upgrade: connecting and backing off', async () => {
    // meta already listed live, so a 404 here is most likely a proxy that strips Upgrade (§3.4).
    const missing = await startTestWsServer({ status: 404 });
    try {
      const { client, timers, log } = makeClient({ url: `http://127.0.0.1:${missing.port}` });
      const a = recorder();
      client.subscribe(WS_A, a.listener);
      timers.fire(await timers.armed(1000));
      await timers.armed(2000);
      expect(missing.handshakes).toHaveLength(2);
      expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
      expect(client.state).toBe('connecting');
      expect(log.mock.calls.some(([message]) => message.includes('the upgrade answered 404'))).toBe(true);
    } finally {
      await missing.close();
    }
  });

  it('treats any other refused upgrade as a failed attempt: connecting and backing off', async () => {
    const proxy = await startTestWsServer({ status: 502 });
    try {
      const { client, timers } = makeClient({ url: `http://127.0.0.1:${proxy.port}` });
      const a = recorder();
      client.subscribe(WS_A, a.listener);
      timers.fire(await timers.armed(1000));
      await timers.armed(2000);
      expect(proxy.handshakes).toHaveLength(2);
      expect(a.events).toEqual([{ kind: 'state', state: 'connecting' }]);
      expect(client.state).toBe('connecting');
    } finally {
      await proxy.close();
    }
  });
});
