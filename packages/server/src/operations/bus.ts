/**
 * The notification bus (hosted edition spec §20.3, ADR-0037): every announcement of this process reaches the other
 * instances' `cluster` listeners through PostgreSQL's `LISTEN`/`NOTIFY`.
 *
 * - **One listening connection per process,** opened by the start-up on the server-running lock's URL (a direct
 *   connection: a transaction pooler cannot hold `LISTEN`). The channel is `wirebench_bus_` and the hex of
 *   `hashtext(SERVER_SCHEMA)`, computed in SQL, so two schemas on one database never hear each other.
 * - **Sending.** {@link NotificationBus.send} encodes the event at once and queues it (a big room's presence as
 *   several parts); the queue drains in order, one `select pg_notify($1, $2)` at a time, on the pool and outside any
 *   tenant unit. A failed send is tried again, {@link SEND_RETRY_DELAYS_MS} apart, before it is given up. The queue
 *   holds at most {@link QUEUE_LIMIT} payloads: a full queue drops the oldest and counts it
 *   ({@link NotificationBus.stats}).
 * - **The missed marker** (review I2). After a payload is dropped or given up, the bus sends one tenant-less `resync`
 *   as soon as a send can go: at once when the queue is idle, else ahead of the next payload. A peer that hears it
 *   resyncs everything, exactly as after its own lost bus: its `onListen` listeners run with `reconnected: true`.
 * - **Receiving.** A notification from this process's own holder is dropped: its listeners heard it at once. The
 *   rest are decoded, refused whole when out of shape, and delivered in arrival order to the `cluster` and `remote`
 *   listeners; a kind none of them hears is dropped before anything is looked up. An event that carries a scope gets
 *   it rebuilt from `tenantId` through the tenant directory, cached per tenant until the directory changes; an
 *   unknown tenant's is dropped. The inbox holds at most {@link INBOX_LIMIT} notifications: a full one drops the
 *   oldest, and once it drains this process resyncs as after a lost bus (review M5).
 * - **A lost connection** calls the `onLost` listeners and reconnects with a backoff of 1 s doubling to 30 s; each
 *   time it listens again, the `onListen` listeners run, so the hub can resync and the caches invalidate.
 */
import type { FastifyBaseLogger } from 'fastify';
import { connectBus, deliverRemote, type AnnouncementKind, type Announcements, type ServerHooks } from '../context.js';
import { LOCK_SCHEMA_KEY } from '../tenancy/running-lock.js';
import type { TenantScope } from '../tenancy/scope.js';
import { decode, encode, type BusMessage } from './bus-codec.js';

/** At most this many payloads wait to be sent (spec §20.3). */
export const QUEUE_LIMIT = 10_000;
export const RETRY_DELAY_MS = 1_000;
export const MAX_RETRY_DELAY_MS = 30_000;
/** How long {@link NotificationBus.stop} waits for the queue to drain. */
export const FLUSH_MS = 2_000;
/** The waits between a failed send's three tries (review I2). */
export const SEND_RETRY_DELAYS_MS: readonly number[] = [100, 1_000];
/** At most this many received notifications wait to be delivered (review M5). */
export const INBOX_LIMIT = 10_000;

/** The channel's name, computed once per connection in SQL from the schema the server's tables are in. */
const CHANNEL = `select 'wirebench_bus_' || to_hex(${LOCK_SCHEMA_KEY}) as channel`;
const CHANNEL_NAME = /^wirebench_bus_[0-9a-f]{1,8}$/;
const NOTIFY = 'select pg_notify($1, $2)';

/** The pool, for sending: the bus's statements are unscoped and run in no tenant unit. */
export interface BusQuerier {
  query(text: string, params?: readonly unknown[]): Promise<unknown>;
}

/** The listening connection: `openSession` in `db/pool.ts`, which the start-up opens. */
export interface BusConnection {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[] }>;
  onLost(listener: (error: Error) => void): void;
  onNotification(listener: (channel: string, payload: string) => void): void;
  close(): Promise<void>;
}

export interface BusDeps {
  readonly db: BusQuerier;
  /** This process's id (`ctx.instance.holder`): the `from` of what it sends, and what it ignores on receipt. */
  readonly holder: string;
  readonly hooks: ServerHooks;
  readonly open: () => Promise<BusConnection>;
  /** The tenant's scope by id, `undefined` for none: how `accessChanged` and `licenseChanged` get theirs back. */
  readonly scopeFor: (tenantId: string) => Promise<TenantScope | undefined>;
  readonly log: FastifyBaseLogger;
  /** Told each heard notification's lag, its send time to now: `wirebench.bus.lag` (spec §20.8). */
  readonly lag?: (ms: number) => void;
  readonly queueLimit?: number;
  readonly inboxLimit?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
  readonly sendRetryDelaysMs?: readonly number[];
}

export interface BusStats {
  /** Payloads waiting to be sent. */
  readonly queued: number;
  /** Payloads dropped from a full queue since start (spec §20.8's metric). */
  readonly dropped: number;
  /** Payloads whose `pg_notify` failed every try and were given up. */
  readonly failed: number;
  /** Received notifications dropped from a full inbox since start. */
  readonly inboxDropped: number;
}

/**
 * What an `onListen` listener is told: whether this is a listen after a loss. `reconnected: true` also comes when
 * the bus learned it missed events without losing its connection (a peer's missed marker, its own full inbox): the
 * listener resyncs the same way either way.
 */
export interface Listened {
  readonly reconnected: boolean;
}

const SCOPED: ReadonlySet<AnnouncementKind> = new Set<AnnouncementKind>(['accessChanged', 'licenseChanged']);

export class NotificationBus {
  readonly #deps: BusDeps;
  readonly #queue: string[] = [];
  readonly #listened: ((listened: Listened) => void)[] = [];
  readonly #lost: ((error: Error) => void)[] = [];
  /** The scopes {@link BusDeps.scopeFor} found, by tenant id, until the directory changes (review M5). */
  readonly #scopes = new Map<string, Promise<TenantScope | undefined>>();
  readonly #inbox: BusMessage[] = [];
  #channel: string | undefined;
  #connection: BusConnection | undefined;
  #draining: Promise<void> | undefined;
  #delivering = false;
  /** A payload was dropped or given up, and the peers have not been told yet (review I2). */
  #missed = false;
  /** The inbox dropped a notification, so this process resyncs once it drains (review M5). */
  #inboxLost = false;
  /** Numbers each big presence list's parts (review M1). */
  #seq = 0;
  #dropped = 0;
  #failed = 0;
  #inboxDropped = 0;
  #stopped = false;
  #disconnect: (() => void) | undefined;
  #wake: (() => void) | undefined;

  constructor(deps: BusDeps) {
    this.#deps = deps;
  }

  /**
   * Listens, and from then on carries every announcement of `hooks`. A failure to listen the first time throws. The
   * lists are connected first, so what an `onListen` listener announces on the first listen is carried too.
   */
  async start(): Promise<void> {
    this.#disconnect = connectBus(this.#deps.hooks, (kind, event) => {
      if (kind === 'tenantsChanged') this.#scopes.clear();
      this.send(kind, event);
    });
    try {
      await this.#listen(false);
    } catch (error) {
      this.#disconnect();
      this.#disconnect = undefined;
      this.#queue.length = 0;
      throw error;
    }
  }

  /** Runs `listener` after every listen, the first one included. */
  onListen(listener: (listened: Listened) => void): void {
    this.#listened.push(listener);
  }

  /** Runs `listener` when the listening connection is lost. */
  onLost(listener: (error: Error) => void): void {
    this.#lost.push(listener);
  }

  /** The channel this process listens and sends on, once it has listened. */
  get channel(): string | undefined {
    return this.#channel;
  }

  stats(): BusStats {
    return {
      queued: this.#queue.length,
      dropped: this.#dropped,
      failed: this.#failed,
      inboxDropped: this.#inboxDropped,
    };
  }

  /** Queues one event for the other instances. Never throws and never waits. */
  send(kind: AnnouncementKind, event: unknown): void {
    if (this.#stopped) return;
    const payloads = encode(this.#deps.holder, kind, event as object, this.#seq);
    if (payloads === undefined) {
      this.#deps.log.warn({ kind }, 'an announcement was out of shape for the bus and was not sent');
      return;
    }
    if (payloads.length > 1) this.#seq++;
    this.#queue.push(...payloads);
    const limit = this.#deps.queueLimit ?? QUEUE_LIMIT;
    while (this.#queue.length > limit) {
      this.#queue.shift();
      this.#dropped++;
      this.#missed = true;
    }
    this.#pump();
  }

  /**
   * Stops carrying announcements, waits up to `flushMs` for the queue to drain (best effort: what is left is
   * dropped), and closes the listening connection. Idempotent. A drain that ends with more queued starts another,
   * so every one is waited for until the deadline (review M4).
   */
  async stop(flushMs = FLUSH_MS): Promise<void> {
    if (this.#stopped) return;
    this.#disconnect?.();
    this.#disconnect = undefined;
    const deadline = Date.now() + flushMs;
    for (let draining = this.#draining; draining !== undefined; draining = this.#draining) {
      const left = deadline - Date.now();
      if (left <= 0) break;
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([draining, new Promise<void>((done) => (timer = setTimeout(done, left)))]);
      clearTimeout(timer);
    }
    this.#stopped = true;
    this.#queue.length = 0;
    this.#wake?.();
    const connection = this.#connection;
    this.#connection = undefined;
    await connection?.close();
  }

  async #listen(reconnected: boolean): Promise<void> {
    const connection = await this.#deps.open();
    try {
      connection.onNotification((channel, payload) => {
        this.#heard(connection, channel, payload);
      });
      connection.onLost((error) => {
        this.#dropConnection(connection, error);
      });
      const channel = (await connection.query<{ channel: string }>(CHANNEL)).rows[0]?.channel;
      if (channel === undefined || !CHANNEL_NAME.test(channel)) throw new Error('the bus channel could not be named');
      await connection.query(`LISTEN "${channel}"`);
      if (this.#stopped) {
        await connection.close();
        return;
      }
      this.#channel = channel;
      this.#connection = connection;
    } catch (error) {
      await connection.close();
      throw error;
    }
    this.#pump();
    if (reconnected) this.#scopes.clear();
    this.#notifyListened(reconnected);
  }

  #dropConnection(connection: BusConnection, error: Error): void {
    if (this.#stopped || connection !== this.#connection) return;
    this.#connection = undefined;
    void connection.close();
    this.#deps.log.warn({ err: error }, 'the notification bus lost its connection; reconnecting');
    for (const listener of this.#lost) {
      try {
        listener(error);
      } catch (thrown) {
        this.#deps.log.warn({ err: thrown }, 'a bus loss listener failed');
      }
    }
    void this.#reconnect();
  }

  async #reconnect(): Promise<void> {
    const max = this.#deps.maxRetryDelayMs ?? MAX_RETRY_DELAY_MS;
    let delay = this.#deps.retryDelayMs ?? RETRY_DELAY_MS;
    while (!this.#stopped) {
      await new Promise<void>((done) => {
        const timer = setTimeout(done, delay);
        timer.unref();
        this.#wake = () => {
          clearTimeout(timer);
          done();
        };
      });
      this.#wake = undefined;
      if (this.#stopped) return;
      try {
        await this.#listen(true);
        this.#deps.log.info({ channel: this.#channel }, 'the notification bus listens again');
        return;
      } catch (error) {
        this.#deps.log.warn(
          { err: error, retryInMs: Math.min(delay * 2, max) },
          'the notification bus could not listen',
        );
        delay = Math.min(delay * 2, max);
      }
    }
  }

  /**
   * Sends the queue in order, one statement at a time. A payload that fails every try is counted and given up, and
   * the next one goes. The missed marker goes first whenever one is owed; when it fails too, it is owed still, and
   * an idle queue waits for the next send to try it again.
   */
  #pump(): void {
    const channel = this.#channel;
    if (this.#draining !== undefined || channel === undefined) return;
    if (this.#queue.length === 0 && !this.#missed) return;
    this.#draining = (async () => {
      while (!this.#stopped) {
        if (this.#missed) {
          if (await this.#sendWithRetry(channel, this.#marker())) this.#missed = false;
          else if (this.#queue.length === 0) break;
        }
        const payload = this.#queue.shift();
        if (payload === undefined) break;
        if (!(await this.#sendWithRetry(channel, payload))) {
          this.#failed++;
          this.#missed = true;
          this.#deps.log.warn('an announcement could not be sent to the other instances; they will resync');
        }
      }
    })().finally(() => {
      this.#draining = undefined;
      if (this.#queue.length > 0) this.#pump();
    });
  }

  /** The tenant-less `resync`: every peer resyncs everything. */
  #marker(): string {
    return encode(this.#deps.holder, 'resync', {})![0]!;
  }

  /** One payload, tried up to three times; whether it went. Stops trying once the bus stops. */
  async #sendWithRetry(channel: string, payload: string): Promise<boolean> {
    const delays = this.#deps.sendRetryDelaysMs ?? SEND_RETRY_DELAYS_MS;
    for (let attempt = 0; ; attempt++) {
      try {
        await this.#deps.db.query(NOTIFY, [channel, payload]);
        return true;
      } catch (error) {
        const delay = delays[attempt];
        if (delay === undefined || this.#stopped) {
          this.#deps.log.warn({ err: error }, 'a bus notification could not be sent');
          return false;
        }
        await new Promise<void>((done) => setTimeout(done, delay).unref());
        if (this.#stopped) return false;
      }
    }
  }

  #heard(connection: BusConnection, channel: string, payload: string): void {
    if (this.#stopped || connection !== this.#connection || channel !== this.#channel) return;
    const message = decode(payload);
    if (message === undefined) {
      this.#deps.log.warn({ bytes: payload.length }, 'a bus notification was not understood and was dropped');
      return;
    }
    if (message.from === this.#deps.holder) return;
    if (message.at !== undefined) this.#deps.lag?.(Date.now() - message.at);
    this.#inbox.push(message);
    const limit = this.#deps.inboxLimit ?? INBOX_LIMIT;
    while (this.#inbox.length > limit) {
      this.#inbox.shift();
      this.#inboxDropped++;
      this.#inboxLost = true;
    }
    if (!this.#delivering) void this.#drainInbox();
  }

  /** Delivers the inbox in arrival order; a full inbox's loss is a resync once it is empty. */
  async #drainInbox(): Promise<void> {
    this.#delivering = true;
    try {
      for (;;) {
        const message = this.#inbox.shift();
        if (message === undefined || this.#stopped) break;
        try {
          await this.#deliver(message);
        } catch (error) {
          this.#deps.log.warn({ err: error }, 'a bus notification could not be delivered');
        }
      }
      if (this.#inboxLost && !this.#stopped) {
        this.#inboxLost = false;
        this.#deps.log.warn('the bus inbox was full and dropped notifications; resyncing');
        this.#resyncAll();
      }
    } finally {
      this.#delivering = false;
    }
  }

  async #deliver(message: BusMessage): Promise<void> {
    if (message.kind === 'resync' && message.event.tenantId === undefined) {
      this.#resyncAll();
      return;
    }
    if (message.kind === 'tenantsChanged') this.#scopes.clear();
    const listeners = this.#deps.hooks[message.kind] as Announcements<unknown>;
    if (listeners.clustered().length === 0) return;
    let event: object = message.event;
    if (SCOPED.has(message.kind)) {
      const tenantId = (message.event as { readonly tenantId: string }).tenantId;
      const tenant = await this.#scopeOf(tenantId);
      if (tenant?.tenantId !== tenantId) return;
      event = { ...message.event, tenant };
    }
    if (this.#stopped) return;
    deliverRemote(listeners, event, this.#deps.log);
  }

  /** The tenant's scope, from the cache or the directory; a tenant not found (or a failed lookup) is not kept. */
  #scopeOf(tenantId: string): Promise<TenantScope | undefined> {
    let found = this.#scopes.get(tenantId);
    if (found === undefined) {
      found = this.#deps.scopeFor(tenantId);
      this.#scopes.set(tenantId, found);
      found.then(
        (scope) => {
          if (scope === undefined && this.#scopes.get(tenantId) === found) this.#scopes.delete(tenantId);
        },
        () => {
          if (this.#scopes.get(tenantId) === found) this.#scopes.delete(tenantId);
        },
      );
    }
    return found;
  }

  /**
   * This process missed events (a peer's missed marker, its own full inbox): the same resync as after a lost bus,
   * through the same `onListen` listeners (review I2, M5).
   */
  #resyncAll(): void {
    this.#scopes.clear();
    this.#notifyListened(true);
  }

  #notifyListened(reconnected: boolean): void {
    for (const listener of this.#listened) {
      try {
        listener({ reconnected });
      } catch (error) {
        this.#deps.log.warn({ err: error }, 'a bus listen listener failed');
      }
    }
  }
}

/**
 * What a module sees of the bus (`ctx.bus`): when it listens and when it is lost (spec §20.3). Modules register
 * before the start-up makes the bus, so they register here, and the start-up {@link attach}es the bus once it has
 * one. A context without a bus (a test's, the admin command line's) has signals that never fire.
 */
export interface BusEvents {
  /** After every listen, the first one included (`reconnected: false`). */
  onListen(listener: (listened: Listened) => void): void;
  onLost(listener: (error: Error) => void): void;
}

export class BusSignals implements BusEvents {
  readonly #listened: ((listened: Listened) => void)[] = [];
  readonly #lost: ((error: Error) => void)[] = [];

  onListen(listener: (listened: Listened) => void): void {
    this.#listened.push(listener);
  }

  onLost(listener: (error: Error) => void): void {
    this.#lost.push(listener);
  }

  /** Forwards `bus`'s listens and losses to every listener registered here, before or after; the bus logs a throw. */
  attach(bus: NotificationBus): void {
    bus.onListen((listened) => {
      everyOne(this.#listened, listened);
    });
    bus.onLost((error) => {
      everyOne(this.#lost, error);
    });
  }
}

/** Runs every listener; one that throws does not stop the rest, and the first throw is rethrown at the end. */
function everyOne<T>(listeners: readonly ((value: T) => void)[], value: T): void {
  let first: { error: unknown } | undefined;
  for (const listener of listeners) {
    try {
      listener(value);
    } catch (error) {
      first ??= { error };
    }
  }
  if (first !== undefined) throw first.error;
}
