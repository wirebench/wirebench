/**
 * One live socket to one Wirebench Server (live-updates spec §3.4, §5.3). It opens when the first
 * workspace subscribes and the server offers `live`, sends the account's token in the first
 * message and nowhere else, subscribes every workspace on `ready`, and turns what the server says
 * into {@link LiveEvent}s. Every failure backs off and tries again, a refused upgrade of any status
 * included, except `4401`, which runs the normal token check and waits for a new sign-in. Only
 * `meta` decides that a server has no live endpoint. HTTP stays the source of truth, so nothing here
 * decides a role or a head; an event only says "look again".
 *
 * Electron-free, like everything `ServerBackend` imports (server-sync O4): it imports nothing but
 * the engine, and the socket, the token, the meta call and every timer come in through
 * {@link LiveClientDeps}. Nothing here logs a message or the token.
 */
import {
  LIVE_CAPABILITY,
  LIVE_CLOSE,
  LIVE_LIMITS,
  LIVE_PATH,
  liveServerMessageSchema,
  WirebenchError,
  type ConnectedWebSocket,
  type LiveClientMessage,
  type LiveServerMessage,
} from '@wirebench/engine';

/**
 * `connected`: authenticated and subscribed. `connecting`: opening, authenticating or backing
 * off. `off`: the server has no `live`, the account has no token, the client was closed, or
 * nothing is subscribed. `ended`: the server ended the session (`4401`) and the token check ran;
 * nothing reconnects until {@link LiveClient.reconnect}.
 */
export type LiveState = 'connected' | 'connecting' | 'off' | 'ended';
/** The server messages about one workspace: `head`, `access`, `presence` and `refused`. */
export type LiveWorkspaceMessage = Extract<LiveServerMessage, { workspaceId: string }>;
export type LiveEvent =
  | { readonly kind: 'message'; readonly message: LiveWorkspaceMessage } // presence already without self
  | { readonly kind: 'state'; readonly state: LiveState };

export interface LiveClientDeps {
  /** The stored server origin (`ServerAccount.url`); {@link liveUrl} derives the socket URL. */
  readonly url: string;
  /**
   * The engine's `connectWebSocket` with the app's TLS and proxy (R5). Always called after
   * {@link meta} in the same attempt: the app's `connect` reads the settings `ServerClient`
   * resolved for this origin during that call.
   */
  readonly connect: (wsUrl: string) => ConnectedWebSocket;
  /** The account's device token; `undefined` when signed out. */
  readonly tokenFor: () => Promise<string | undefined>;
  /** The normal token check (`AccountService.refresh`), run on `4401`. */
  readonly refresh: () => Promise<void>;
  /** `GET /api/v1/meta`, asked for the `live` capability before every connect. */
  readonly meta: () => Promise<{ readonly capabilities: readonly string[] }>;
  /** The account's own user id, which `presence` never reports. */
  readonly userId: () => string | undefined;
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** In [0, 1]: the back-off jitter. */
  readonly random: () => number;
  /** The connection's lifecycle only: never a message, never the token. */
  readonly log?: (message: string) => void;
}

type Timer = ReturnType<LiveClientDeps['setTimer']>;

/** How long `ready` may take once the socket is asked for, and `pong` after `ping` (§3.4). */
const REPLY_TIMEOUT_MS = 10_000;
const BASE_BACKOFF_MS = 1000;
/** The back-off ceiling, and the fixed wait after `4429` (§3.4). */
const MAX_BACKOFF_MS = 60_000;
/** How long a socket this side closes may take to finish the close handshake before it is disposed. */
const CLOSE_GRACE_MS = 5_000;
/** `WebSocket.OPEN` and `WebSocket.CLOSED`, spelled out so this module needs no global constructor. */
const OPEN = 1;
const CLOSED = 3;
/**
 * The server message types this client knows. The engine's union is closed, so a newer server's
 * type would fail it: anything not listed here is ignored before the schema sees it (§3.1, §4). A
 * `Record` over the union, so a type added to the engine fails to compile here until it is listed.
 */
const KNOWN: Record<LiveServerMessage['type'], true> = {
  ready: true,
  head: true,
  access: true,
  presence: true,
  refused: true,
  'session-ended': true,
  pong: true,
};

/** `min(60 s, 1 s × 2^attempt)`, times a random factor in [0.5, 1] (§3.4). */
export function backoffMs(attempt: number, random: () => number): number {
  return Math.min(MAX_BACKOFF_MS, BASE_BACKOFF_MS * 2 ** attempt) * (0.5 + 0.5 * random());
}

/** The live endpoint on a stored origin: `https:` becomes `wss:` and `http:` becomes `ws:`, never lower (§6). */
export function liveUrl(origin: string): string {
  const url = new URL(LIVE_PATH, origin);
  if (url.protocol === 'https:') url.protocol = 'wss:';
  else if (url.protocol === 'http:') url.protocol = 'ws:';
  else throw new WirebenchError('server-url-invalid', 'The server address must start with https:// or http://');
  return url.toString();
}

/** A known server message, or `undefined` for anything else: not JSON, no `type`, an unknown type, malformed. */
function parseServerMessage(data: unknown): LiveServerMessage | undefined {
  if (typeof data !== 'string') return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(data);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) return undefined;
  const type = (parsed as { readonly type?: unknown }).type;
  if (typeof type !== 'string' || !Object.hasOwn(KNOWN, type)) return undefined;
  const result = liveServerMessageSchema.safeParse(parsed);
  return result.success ? result.data : undefined;
}

interface Subscriber {
  readonly listener: (event: LiveEvent) => void;
  /** Set once the listener has been called; the catch-up after `subscribe` skips it then. */
  seen: boolean;
  active: boolean;
}

interface Connection {
  readonly opened: ConnectedWebSocket;
  ready: boolean;
  /** The `ready` deadline, the next heartbeat or the `pong` deadline: one at a time. */
  timer: Timer | undefined;
}

/**
 * `idle`: nothing subscribed. `active`: connecting, connected or backing off. `halted`: stopped
 * until {@link LiveClient.reconnect}: closed, session ended, no `live`, or no token.
 */
type Phase = 'idle' | 'active' | 'halted';

export class LiveClient {
  private readonly workspaces = new Map<string, Set<Subscriber>>();
  /** The last `presence` per subscribed workspace, without self, for a listener that joins later. */
  private readonly presence = new Map<string, LiveWorkspaceMessage>();
  private phase: Phase = 'idle';
  private current: LiveState = 'off';
  private conn: Connection | undefined;
  private retry: Timer | undefined;
  private attempt = 0;
  /** Bumped by every stop, so an await or a timer that resumes into a newer run does nothing. */
  private run = 0;
  private warnedTooMany = false;

  constructor(private readonly deps: LiveClientDeps) {}

  get state(): LiveState {
    return this.current;
  }

  /**
   * Adds a listener for one workspace. The first subscription opens the socket; a workspace new to
   * an open socket is subscribed at once. The listener is never called from inside this method: it
   * hears the next state change, or a catch-up with the current state and last presence. The
   * returned function unsubscribes once; the last one closes the socket `1000`.
   */
  subscribe(workspaceId: string, listener: (event: LiveEvent) => void): () => void {
    const set = this.workspaces.get(workspaceId) ?? new Set<Subscriber>();
    const fresh = set.size === 0;
    this.workspaces.set(workspaceId, set);
    const subscriber: Subscriber = { listener, seen: false, active: true };
    set.add(subscriber);
    if (fresh && this.conn?.ready === true) this.send(this.conn, { type: 'subscribe', workspaceId });
    if (this.phase === 'idle') this.start();
    queueMicrotask(() => this.catchUp(workspaceId, subscriber));
    return () => this.leave(workspaceId, subscriber);
  }

  /** A new token after an account change: drop the socket and start again at once, back-off reset. */
  reconnect(): void {
    void this.stop();
    this.attempt = 0;
    this.phase = 'idle';
    if (this.workspaces.size > 0) this.start();
  }

  /** Closes the socket `1000` and stays down until {@link reconnect}; resolves once the socket is released. */
  async close(): Promise<void> {
    const stopped = this.stop();
    this.phase = 'halted';
    if (this.current !== 'ended') this.setState('off');
    await stopped;
  }

  private start(): void {
    this.phase = 'active';
    const run = this.run;
    queueMicrotask(() => {
      if (run === this.run && this.phase === 'active') void this.open(run);
    });
  }

  /**
   * One attempt: meta for the capability, the token, then the socket, always in that order (see
   * {@link LiveClientDeps.connect}). A failure before the socket backs off like a dropped one.
   */
  private async open(run: number): Promise<void> {
    this.setState('connecting');
    let token: string | undefined;
    try {
      const meta = await this.deps.meta();
      if (run !== this.run) return;
      if (!meta.capabilities.includes(LIVE_CAPABILITY)) {
        this.halt('the server does not offer live updates');
        return;
      }
      token = await this.deps.tokenFor();
    } catch {
      // Offline, or the server is down: the same back-off as a dropped socket.
      if (run === this.run) this.backOff(backoffMs(this.attempt++, this.deps.random));
      return;
    }
    if (run !== this.run) return;
    if (token === undefined) {
      this.halt('signed out');
      return;
    }
    const auth = token;
    let opened: ConnectedWebSocket;
    try {
      opened = this.deps.connect(liveUrl(this.deps.url));
    } catch {
      this.backOff(backoffMs(this.attempt++, this.deps.random));
      return;
    }
    const conn: Connection = { opened, ready: false, timer: undefined };
    this.conn = conn;
    opened.socket.addEventListener('open', () => {
      if (this.conn === conn) this.send(conn, { type: 'auth', token: auth });
    });
    opened.socket.addEventListener('message', (event) => {
      if (this.conn === conn) this.onMessage(conn, event.data);
    });
    // `error` always comes before `close`, and a refused upgrade closes `1006` with its status in
    // `refusedStatus()`, so `close` alone decides what happens next.
    opened.socket.addEventListener('close', (event) => {
      if (this.conn === conn) this.onClose(conn, event.code);
    });
    // Armed now rather than on `open`, so a handshake that hangs behind a proxy is covered too.
    conn.timer = this.deps.setTimer(() => this.drop(conn, 'no ready in time'), REPLY_TIMEOUT_MS);
  }

  private onMessage(conn: Connection, data: unknown): void {
    const message = parseServerMessage(data);
    if (message === undefined) return;
    switch (message.type) {
      case 'ready':
        this.onReady(conn);
        return;
      case 'pong':
        if (conn.ready) {
          // The connection stayed up a heartbeat: only now does the back-off start over, so a server
          // that says `ready` and then drops the socket still backs off further each time (§3.4).
          this.attempt = 0;
          this.armHeartbeat(conn);
        }
        return;
      case 'session-ended':
        // The `4401` close that follows runs the token check.
        return;
      case 'presence': {
        const self = this.deps.userId();
        const others = { ...message, users: message.users.filter((user) => user.id !== self) };
        if (this.workspaces.has(message.workspaceId)) this.presence.set(message.workspaceId, others);
        this.deliver(message.workspaceId, { kind: 'message', message: others });
        return;
      }
      case 'refused':
        // Forwarded as it is; `ServerBackend` turns it into `access`, and too-many into `live: 'off'` too.
        if (message.code === 'live-too-many-subscriptions' && !this.warnedTooMany) {
          this.warnedTooMany = true;
          this.log('the server refused a subscription: too many on this session; that workspace keeps polling');
        }
        this.deliver(message.workspaceId, { kind: 'message', message });
        return;
      case 'head':
      case 'access':
        this.deliver(message.workspaceId, { kind: 'message', message });
        return;
    }
  }

  private onReady(conn: Connection): void {
    if (conn.ready) return;
    conn.ready = true;
    conn.timer?.cancel();
    for (const workspaceId of this.workspaces.keys()) this.send(conn, { type: 'subscribe', workspaceId });
    // Before the state change: a listener that unsubscribes the last workspace stops this socket,
    // and must find the heartbeat already armed so it gets cancelled.
    this.armHeartbeat(conn);
    this.setState('connected');
  }

  /** `ping` after 30 s, then a 10 s wait for `pong`; any `pong` starts the 30 s over (§3.4, R6). */
  private armHeartbeat(conn: Connection): void {
    conn.timer?.cancel();
    conn.timer = this.deps.setTimer(() => {
      if (this.conn !== conn) return;
      this.send(conn, { type: 'ping' });
      conn.timer = this.deps.setTimer(() => this.drop(conn, 'no pong in time'), REPLY_TIMEOUT_MS);
    }, LIVE_LIMITS.heartbeatMs);
  }

  /** The server closed the socket, or it never opened: §3.1's desktop reactions. */
  private onClose(conn: Connection, code: number): void {
    this.conn = undefined;
    conn.timer?.cancel();
    this.presence.clear();
    void conn.opened.dispose().catch(() => undefined);
    // A refused upgrade, `404` included, backs off like a dropped socket: `meta` listed `live`, so a
    // `404` is most likely a proxy that strips `Upgrade`, and polling covers the gap (§3.4).
    const refusedStatus = conn.opened.refusedStatus();
    if (refusedStatus !== undefined) this.log(`the upgrade answered ${String(refusedStatus)}`);
    else this.log(code === LIVE_CLOSE.tooBig ? 'closed 1009: a message was too big' : `closed ${String(code)}`);
    if (code === LIVE_CLOSE.unauthenticated) {
      void this.endSession();
      return;
    }
    this.backOff(code === LIVE_CLOSE.tooManySockets ? MAX_BACKOFF_MS : backoffMs(this.attempt++, this.deps.random));
  }

  /**
   * `4401`: the normal token check first, so the account already reads signed out when the backend
   * hears `ended` and fetches (§3.4). A `close()` during the check does not suppress `ended`; a
   * `reconnect()` (a new sign-in) does.
   */
  private async endSession(): Promise<void> {
    this.phase = 'halted';
    await this.deps.refresh().catch(() => undefined);
    // Widened: TypeScript keeps the narrowing to `halted` across the await, but a `reconnect()`
    // during the check sets `active`.
    if ((this.phase as Phase) === 'active') return;
    this.setState('ended');
  }

  /** This side gives up on a socket (no `ready`, no `pong`): close it `1000` and back off. */
  private drop(conn: Connection, reason: string): void {
    if (this.conn !== conn) return;
    this.log(`${reason}; reconnecting`);
    this.conn = undefined;
    this.presence.clear();
    void this.release(conn);
    this.backOff(backoffMs(this.attempt++, this.deps.random));
  }

  private backOff(ms: number): void {
    this.setState('connecting');
    const run = this.run;
    this.retry = this.deps.setTimer(() => {
      this.retry = undefined;
      if (run === this.run && this.phase === 'active') void this.open(run);
    }, ms);
  }

  private halt(reason: string): void {
    this.phase = 'halted';
    this.log(`${reason}; staying off`);
    this.setState('off');
  }

  /** Ends the current run: no retry, no socket. Resolves once the old socket is released. */
  private stop(): Promise<void> {
    this.run += 1;
    this.retry?.cancel();
    this.retry = undefined;
    this.presence.clear();
    const conn = this.conn;
    this.conn = undefined;
    return conn === undefined ? Promise.resolve() : this.release(conn);
  }

  /** Closes `1000`, then disposes once the close handshake ends or {@link CLOSE_GRACE_MS} passes. */
  private release(conn: Connection): Promise<void> {
    conn.timer?.cancel();
    const { socket } = conn.opened;
    return new Promise<void>((resolve) => {
      if (socket.readyState === CLOSED) {
        conn.opened.dispose().then(resolve, () => resolve());
        return;
      }
      let done = false;
      const finish = (): void => {
        if (done) return;
        done = true;
        grace.cancel();
        conn.opened.dispose().then(resolve, () => resolve());
      };
      // Armed before the listener and the close, so `finish` always has it to cancel.
      const grace = this.deps.setTimer(finish, CLOSE_GRACE_MS);
      socket.addEventListener('close', finish, { once: true });
      try {
        socket.close(LIVE_CLOSE.normal);
      } catch {
        finish();
      }
    });
  }

  private leave(workspaceId: string, subscriber: Subscriber): void {
    if (!subscriber.active) return;
    subscriber.active = false;
    const set = this.workspaces.get(workspaceId);
    if (set === undefined || !set.delete(subscriber) || set.size > 0) return;
    this.workspaces.delete(workspaceId);
    this.presence.delete(workspaceId);
    const last = this.workspaces.size === 0;
    if (!last && this.conn?.ready === true) this.send(this.conn, { type: 'unsubscribe', workspaceId });
    if (last && this.phase === 'active') {
      void this.stop();
      this.phase = 'idle';
      this.current = 'off';
    }
  }

  private catchUp(workspaceId: string, subscriber: Subscriber): void {
    if (!subscriber.active || subscriber.seen) return;
    this.call(subscriber, { kind: 'state', state: this.current });
    const last = this.presence.get(workspaceId);
    if (last !== undefined) this.call(subscriber, { kind: 'message', message: last });
  }

  private setState(state: LiveState): void {
    if (state === this.current) return;
    this.current = state;
    for (const workspaceId of [...this.workspaces.keys()]) this.deliver(workspaceId, { kind: 'state', state });
  }

  private deliver(workspaceId: string, event: LiveEvent): void {
    const set = this.workspaces.get(workspaceId);
    if (set === undefined) return;
    for (const subscriber of [...set]) this.call(subscriber, event);
  }

  private call(subscriber: Subscriber, event: LiveEvent): void {
    if (!subscriber.active) return;
    subscriber.seen = true;
    try {
      subscriber.listener(event);
    } catch {
      this.log('a listener threw');
    }
  }

  private send(conn: Connection, message: LiveClientMessage): void {
    const { socket } = conn.opened;
    if (socket.readyState !== OPEN) return;
    try {
      socket.send(JSON.stringify(message));
    } catch {
      // The close event follows and backs off.
    }
  }

  private log(message: string): void {
    this.deps.log?.(`live ${this.deps.url}: ${message}`);
  }
}
