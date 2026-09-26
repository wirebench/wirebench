import { EventEmitter } from 'node:events';
import Fastify from 'fastify';
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { WebSocket } from 'ws';
import { LIVE_CLOSE, LIVE_LIMITS, WirebenchError } from '@wirebench/engine';
import type { TokenCaller } from '../../../src/identity/guard.js';
import { LiveHub } from '../../../src/live/hub.js';
import { runLiveSocket } from '../../../src/live/socket.js';
import type { Effective } from '../../../src/teams/roles.js';
import { manualTimers } from '../../helpers/timers.js';

const USER_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const TOKEN_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const WS_ID = '01J8ZC5Q0V7R3T9XK2M4N6P8QC';
const TOKEN = `wbs_${'A'.repeat(43)}`;
const CREATED_AT = '2026-09-26T10:00:00.000Z';
const TOKEN_MAX_MS = 180 * 24 * 60 * 60 * 1000;
const NOW = Date.parse('2026-09-26T12:00:00.000Z');
const LOG = Fastify({ logger: false }).log;
const AUTH = { type: 'auth', token: TOKEN };
const CALLER: TokenCaller = {
  caller: { id: USER_ID, email: 'ana@example.com', serverAdmin: false, tokenId: TOKEN_ID },
  displayName: 'Ana',
  tokenCreatedAt: CREATED_AT,
};

/** The slice of a `ws` WebSocket the loop touches, recording what the server did to it. */
class FakeWs extends EventEmitter {
  readonly OPEN = 1;
  readyState = 1;
  readonly sent: unknown[] = [];
  closedWith: number | undefined;
  terminated = false;
  pings = 0;

  send(text: string): void {
    this.sent.push(JSON.parse(text) as unknown);
  }
  close(code: number): void {
    if (this.readyState !== this.OPEN) return;
    this.readyState = 2;
    this.closedWith = code;
  }
  terminate(): void {
    this.readyState = 3;
    this.terminated = true;
  }
  ping(): void {
    this.pings += 1;
  }
  /** A client text frame: a string as is, anything else as JSON. */
  text(message: unknown): void {
    this.emit('message', Buffer.from(typeof message === 'string' ? message : JSON.stringify(message)), false);
  }
  binary(): void {
    this.emit('message', Buffer.from([1, 2, 3]), true);
  }
  /** The connection ended: the last thing `ws` emits. */
  gone(): void {
    this.readyState = 3;
    this.emit('close', 1000, Buffer.alloc(0));
  }
}

type Authenticate = (token: string) => Promise<TokenCaller>;

/** A real hub over fake role lookups; `connect` runs the loop on one more fake socket against it. */
function hubSetup(
  effective: () => Promise<Effective> = () => Promise.resolve<Effective>({ role: 'viewer', source: 'default' }),
) {
  const timers = manualTimers();
  const hub = new LiveHub({
    effectiveRole: effective,
    workspaceIdsOfTeam: () => Promise.resolve([]),
    log: LOG,
    now: () => NOW,
    setTimer: timers.setTimer,
  });
  const connect = (authenticate: Authenticate = () => Promise.resolve(CALLER)) => {
    const ws = new FakeWs();
    const auth = vi.fn(authenticate);
    runLiveSocket(ws as unknown as WebSocket, {
      hub,
      authenticate: auth,
      tokenMaxMs: TOKEN_MAX_MS,
      setTimer: timers.setTimer,
      log: LOG,
    });
    return { ws, auth };
  };
  return { hub, timers, connect };
}

/** One hub with one socket on it. */
function setup(authenticate?: Authenticate) {
  const env = hubSetup();
  return { hub: env.hub, timers: env.timers, ...env.connect(authenticate) };
}

const ready = (ws: FakeWs): Promise<void> => vi.waitFor(() => expect(ws.sent).toEqual([{ type: 'ready' }]));

describe('runLiveSocket (live-updates §3.1, §3.3)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
  });

  it('auth admits the session until the token’s maximum age, the hub answers ready once, and the auth timer is gone', async () => {
    const { ws, hub, timers, auth } = setup();
    const admit = vi.spyOn(hub, 'admit');
    ws.text(AUTH);
    await ready(ws);
    expect(auth).toHaveBeenCalledWith(TOKEN);
    expect(admit.mock.calls[0]?.[1]).toEqual({
      tokenId: TOKEN_ID,
      userId: USER_ID,
      name: 'Ana',
      expiresAt: Date.parse(CREATED_AT) + TOKEN_MAX_MS,
    });
    expect(timers.pending(LIVE_LIMITS.authTimeoutMs)).toBe(0);
    expect(ws.closedWith).toBeUndefined();
  });

  it('no auth before the timer closes 4408, and a lookup still running then is never admitted', async () => {
    const silent = setup();
    expect(silent.timers.fire(LIVE_LIMITS.authTimeoutMs)).toBe(1);
    expect(silent.ws.closedWith).toBe(LIVE_CLOSE.authTimeout);

    let answer!: (caller: TokenCaller) => void;
    const lookup = new Promise<TokenCaller>((resolve) => {
      answer = resolve;
    });
    const slow = setup(() => lookup);
    const admit = vi.spyOn(slow.hub, 'admit');
    slow.ws.text(AUTH);
    expect(slow.auth).toHaveBeenCalledTimes(1);
    expect(slow.timers.fire(LIVE_LIMITS.authTimeoutMs)).toBe(1);
    expect(slow.ws.closedWith).toBe(LIVE_CLOSE.authTimeout);
    answer(CALLER);
    await lookup; // the loop's continuation was queued on it first, so it has run by now
    expect(admit).not.toHaveBeenCalled();
    expect(slow.ws.sent).toEqual([]);
  });

  it('a refused token or a disabled user closes 4401; any other failure closes 1011 and is logged without the token', async () => {
    for (const code of ['identity-unauthenticated', 'identity-user-disabled']) {
      const { ws } = setup(() => Promise.reject(new WirebenchError(code, 'Refused.')));
      ws.text(AUTH);
      await vi.waitFor(() => expect(ws.closedWith).toBe(LIVE_CLOSE.unauthenticated));
      expect(ws.sent).toEqual([]);
    }
    const warn = vi.spyOn(LOG, 'warn');
    const broken = setup(() => Promise.reject(new Error('connection refused')));
    broken.ws.text(AUTH);
    await vi.waitFor(() => expect(broken.ws.closedWith).toBe(LIVE_CLOSE.serverError));
    expect(warn).toHaveBeenCalledTimes(1);
    expect(JSON.stringify(warn.mock.calls)).not.toContain(TOKEN);
  });

  it('closes 4400 on a message that is not JSON, not in the protocol, binary, out of order, or a second auth', async () => {
    const offences: ((ws: FakeWs) => void)[] = [
      (ws) => ws.text('{not json'),
      (ws) => ws.text({ type: 'subscribe', workspaceId: WS_ID }), // not auth first
      (ws) => ws.text({ type: 'auth', token: 'wbs_short' }), // off DEVICE_TOKEN_PATTERN
      (ws) => ws.text({ type: 'shout' }),
      (ws) => ws.binary(),
    ];
    for (const offend of offences) {
      const { ws, auth } = setup();
      offend(ws);
      expect(ws.closedWith).toBe(LIVE_CLOSE.badMessage);
      expect(auth).not.toHaveBeenCalled();
    }
    // While identity looks the token up, the client waits for `ready` (§3.4).
    const waiting = setup(() => new Promise<TokenCaller>(() => undefined));
    waiting.ws.text(AUTH);
    waiting.ws.text({ type: 'ping' });
    expect(waiting.ws.closedWith).toBe(LIVE_CLOSE.badMessage);
    // A token is accepted only as the first message (§12).
    const again = setup();
    again.ws.text(AUTH);
    await ready(again.ws);
    again.ws.text(AUTH);
    expect(again.ws.closedWith).toBe(LIVE_CLOSE.badMessage);
    expect(again.auth).toHaveBeenCalledTimes(1);
  });

  it('the hub closes a user’s 33rd socket 4429; the loop sends nothing more and never removes it', async () => {
    const env = hubSetup();
    const remove = vi.spyOn(env.hub, 'remove');
    for (let n = 0; n < LIVE_LIMITS.maxSocketsPerUser; n += 1) {
      const { ws } = env.connect();
      ws.text(AUTH);
      await ready(ws);
    }
    const extra = env.connect();
    extra.ws.text(AUTH);
    await vi.waitFor(() => expect(extra.ws.closedWith).toBe(LIVE_CLOSE.tooManySockets));
    expect(extra.ws.sent).toEqual([]);
    extra.ws.gone();
    expect(remove).not.toHaveBeenCalled();
  });

  it('after ready: subscribe answers presence through the hub, unsubscribe reaches it, ping answers pong', async () => {
    const { ws, hub } = setup();
    const unsubscribe = vi.spyOn(hub, 'unsubscribe');
    ws.text(AUTH);
    await ready(ws);
    ws.text({ type: 'subscribe', workspaceId: WS_ID });
    await vi.waitFor(() =>
      expect(ws.sent).toContainEqual({ type: 'presence', workspaceId: WS_ID, users: [{ id: USER_ID, name: 'Ana' }] }),
    );
    ws.text({ type: 'unsubscribe', workspaceId: WS_ID });
    expect(unsubscribe.mock.calls[0]?.[1]).toBe(WS_ID);
    ws.text({ type: 'ping' });
    expect(ws.sent.at(-1)).toEqual({ type: 'pong' });
    expect(ws.closedWith).toBeUndefined();
  });

  it('a role query that fails on subscribe closes 1011', async () => {
    const env = hubSetup(() => Promise.reject(new Error('connection refused')));
    const { ws } = env.connect();
    ws.text(AUTH);
    await ready(ws);
    ws.text({ type: 'subscribe', workspaceId: WS_ID });
    await vi.waitFor(() => expect(ws.closedWith).toBe(LIVE_CLOSE.serverError));
  });

  it('protocol pongs reach the hub once admitted; the close removes an admitted socket once and a pending one never', async () => {
    const pending = setup();
    const pendingPong = vi.spyOn(pending.hub, 'pong');
    const pendingRemove = vi.spyOn(pending.hub, 'remove');
    pending.ws.emit('pong', Buffer.alloc(0));
    pending.ws.gone();
    expect(pendingPong).not.toHaveBeenCalled();
    expect(pendingRemove).not.toHaveBeenCalled();
    expect(pending.timers.pending(LIVE_LIMITS.authTimeoutMs)).toBe(0); // the auth timer went with it

    const { ws, hub } = setup();
    const pong = vi.spyOn(hub, 'pong');
    const remove = vi.spyOn(hub, 'remove');
    ws.text(AUTH);
    await ready(ws);
    ws.emit('pong', Buffer.alloc(0));
    expect(pong).toHaveBeenCalledTimes(1);
    ws.gone();
    expect(remove).toHaveBeenCalledTimes(1);
    expect(pong.mock.calls[0]?.[0]).toBe(remove.mock.calls[0]?.[0]); // one adapter per connection, as the hub keys it
  });
});
