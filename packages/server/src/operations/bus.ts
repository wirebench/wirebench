/**
 * The notification bus (hosted edition spec §20.3, ADR-0037): every announcement of this process reaches the other
 * instances' `cluster` listeners through PostgreSQL's `LISTEN`/`NOTIFY`.
 *
 * - **One listening connection per process,** opened by the start-up on the server-running lock's URL (a direct
 *   connection: a transaction pooler cannot hold `LISTEN`). The channel is `wirebench_bus_` and the hex of
 *   `hashtext(SERVER_SCHEMA)`, computed in SQL, so two schemas on one database never hear each other.
 * - **Sending.** {@link NotificationBus.send} encodes the event at once and queues it; the queue drains in order,
 *   one `select pg_notify($1, $2)` at a time, on the pool and outside any tenant unit. It holds at most
 *   {@link QUEUE_LIMIT} payloads: a full queue drops the oldest and counts it ({@link NotificationBus.stats}).
 * - **Receiving.** A notification from this process's own holder is dropped: its listeners heard it at once. The
 *   rest are decoded, refused whole when out of shape, and delivered in arrival order to the `cluster` listeners. An
 *   event that carries a scope gets it rebuilt from `tenantId` through the tenant directory; an unknown tenant's is
 *   dropped.
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
  readonly queueLimit?: number;
  readonly retryDelayMs?: number;
  readonly maxRetryDelayMs?: number;
}

export interface BusStats {
  /** Payloads waiting to be sent. */
  readonly queued: number;
  /** Payloads dropped from a full queue since start (spec §20.8's metric). */
  readonly dropped: number;
  /** Payloads whose `pg_notify` failed. */
  readonly failed: number;
}

/** What an `onListen` listener is told: whether this is a listen after a loss. */
export interface Listened {
  readonly reconnected: boolean;
}

const SCOPED: ReadonlySet<AnnouncementKind> = new Set<AnnouncementKind>(['accessChanged', 'licenseChanged']);

export class NotificationBus {
  readonly #deps: BusDeps;
  readonly #queue: string[] = [];
  readonly #listened: ((listened: Listened) => void)[] = [];
  readonly #lost: ((error: Error) => void)[] = [];
  #channel: string | undefined;
  #connection: BusConnection | undefined;
  #draining: Promise<void> | undefined;
  #inbox: Promise<void> = Promise.resolve();
  #dropped = 0;
  #failed = 0;
  #stopped = false;
  #disconnect: (() => void) | undefined;
  #wake: (() => void) | undefined;

  constructor(deps: BusDeps) {
    this.#deps = deps;
  }

  /** Listens, and from then on carries every announcement of `hooks`. A failure to listen the first time throws. */
  async start(): Promise<void> {
    await this.#listen(false);
    this.#disconnect = connectBus(this.#deps.hooks, (kind, event) => {
      this.send(kind, event);
    });
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
    return { queued: this.#queue.length, dropped: this.#dropped, failed: this.#failed };
  }

  /** Queues one event for the other instances. Never throws and never waits. */
  send(kind: AnnouncementKind, event: unknown): void {
    if (this.#stopped) return;
    const payload = encode(this.#deps.holder, kind, event as object);
    if (payload === undefined) {
      this.#deps.log.warn({ kind }, 'an announcement was out of shape for the bus and was not sent');
      return;
    }
    this.#queue.push(payload);
    const limit = this.#deps.queueLimit ?? QUEUE_LIMIT;
    while (this.#queue.length > limit) {
      this.#queue.shift();
      this.#dropped++;
    }
    this.#pump();
  }

  /**
   * Stops carrying announcements, waits up to `flushMs` for the queue to drain (best effort: what is left is
   * dropped), and closes the listening connection. Idempotent.
   */
  async stop(flushMs = FLUSH_MS): Promise<void> {
    if (this.#stopped) return;
    this.#disconnect?.();
    this.#disconnect = undefined;
    const draining = this.#draining;
    if (draining !== undefined && flushMs > 0) {
      let timer: NodeJS.Timeout | undefined;
      await Promise.race([draining, new Promise<void>((done) => (timer = setTimeout(done, flushMs)))]);
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
    for (const listener of this.#listened) {
      try {
        listener({ reconnected });
      } catch (error) {
        this.#deps.log.warn({ err: error }, 'a bus listen listener failed');
      }
    }
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

  /** Sends the queue in order, one statement at a time; a failed send is counted and the next one goes. */
  #pump(): void {
    const channel = this.#channel;
    if (this.#draining !== undefined || channel === undefined || this.#queue.length === 0) return;
    this.#draining = (async () => {
      while (this.#queue.length > 0 && !this.#stopped) {
        const payload = this.#queue.shift()!;
        try {
          await this.#deps.db.query(NOTIFY, [channel, payload]);
        } catch (error) {
          this.#failed++;
          this.#deps.log.warn({ err: error }, 'an announcement could not be sent to the other instances');
        }
      }
    })().finally(() => {
      this.#draining = undefined;
      this.#pump();
    });
  }

  #heard(connection: BusConnection, channel: string, payload: string): void {
    if (this.#stopped || connection !== this.#connection || channel !== this.#channel) return;
    const message = decode(payload);
    if (message === undefined) {
      this.#deps.log.warn({ bytes: payload.length }, 'a bus notification was not understood and was dropped');
      return;
    }
    if (message.from === this.#deps.holder) return;
    this.#inbox = this.#inbox
      .then(() => this.#deliver(message))
      .catch((error: unknown) => {
        this.#deps.log.warn({ err: error }, 'a bus notification could not be delivered');
      });
  }

  async #deliver(message: BusMessage): Promise<void> {
    let event: object = message.event;
    if (SCOPED.has(message.kind)) {
      const tenantId = (message.event as { readonly tenantId: string }).tenantId;
      const tenant = await this.#deps.scopeFor(tenantId);
      if (tenant?.tenantId !== tenantId) return;
      event = { ...message.event, tenant };
    }
    if (this.#stopped) return;
    deliverRemote(this.#deps.hooks[message.kind] as Announcements<unknown>, event, this.#deps.log);
  }
}
