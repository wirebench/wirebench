import pg from 'pg';
import type { Database, Querier } from './querier.js';

function querierOf(runner: { query(text: string, values?: unknown[]): Promise<pg.QueryResult> }): Querier {
  return {
    query: async (text, params) => {
      const result = await runner.query(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows as never[], rowCount: result.rowCount };
    },
  };
}

/**
 * A querier over one pooled client that counts the statements it has sent and not yet seen settle. Kept here
 * rather than read from `pg`'s own fields, which are undocumented and deprecated: a client with any statement
 * still out after its unit is in doubt (fail closed).
 */
function countingQuerier(client: pg.PoolClient): { readonly querier: Querier; readonly inFlight: () => number } {
  let inFlight = 0;
  const base = querierOf(client);
  return {
    querier: {
      query: async (text, params) => {
        inFlight++;
        try {
          return await base.query(text, params);
        } finally {
          inFlight--;
        }
      },
    },
    inFlight: () => inFlight,
  };
}

/** The part of `pg.Pool` a `Database` uses, so a test can hand it a stub. */
export type PoolLike = Pick<pg.Pool, 'query' | 'connect' | 'on' | 'end'>;

export interface DatabaseOptions {
  /** The pool's size; 10 by default. Tests pass 1 to see what the next unit gets back. */
  readonly max?: number;
  /** Told when a connection fails, pooled or mid-unit, never with the connection string. */
  readonly onError?: (error: Error) => void;
  /** Shows up in `pg_stat_activity`, so `admin tenancy revert` can tell a running server's connections. */
  readonly applicationName?: string;
  /** Test only: the pool to use instead of a real one. */
  readonly pool?: PoolLike;
}

/**
 * What every server connection is called in `pg_stat_activity`; the lock's own adds `-lock`. The command line's
 * are `wirebench-admin` and `wirebench-migrate`, so a revert, which refuses while a `wirebench-server…` session
 * remains, is not held up by an admin command.
 */
export const APPLICATION_NAME = 'wirebench-server';
export const ADMIN_APPLICATION_NAME = 'wirebench-admin';

/** A `pg.Pool` behind the `Database` interface; the one place `pg` is imported. */
export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool =
    options.pool ??
    new pg.Pool({
      connectionString,
      max: options.max ?? 10,
      application_name: options.applicationName ?? APPLICATION_NAME,
    });
  const onError = (error: Error): void => {
    options.onError?.(error);
  };
  // A pooled client whose server end goes away while it is idle emits `error`; without a listener
  // that would crash the process. The pool drops the client itself.
  pool.on('error', onError);
  return {
    ...querierOf(pool),
    async transaction(fn) {
      const client = await pool.connect();
      // A connection that fails mid-unit emits `error` on the client; the failed query rejects as well, and
      // the client is destroyed below, so the event itself is only reported.
      client.on('error', onError);
      // A client in doubt is destroyed, never reused (hosted edition spec §19.4): one whose rollback
      // failed may still be inside the transaction, and one that is not idle has a statement of this
      // unit still running. `release(error)` ends its connection instead of pooling it.
      let doubt: Error | undefined;
      const counted = countingQuerier(client);
      try {
        await client.query('BEGIN');
        const result = await fn(counted.querier);
        await client.query('COMMIT');
        return result;
      } catch (error) {
        try {
          await client.query('ROLLBACK');
        } catch (rollback) {
          doubt = rollback instanceof Error ? rollback : new Error(String(rollback));
        }
        throw error;
      } finally {
        // A statement of the unit that nobody awaited is still out: the client is not fit to go back.
        if (doubt === undefined && counted.inFlight() > 0) doubt = new Error('the client is not idle after its unit');
        client.off('error', onError);
        client.release(doubt);
      }
    },
    close: () => pool.end(),
  };
}

/** One connection outside any pool, for a session-level lock held for the life of the process. */
export interface Session extends Querier {
  /** The server process behind the connection, for a test that ends it. */
  readonly pid: number;
  /** The row of {@link SessionOptions.first}, when one was given. */
  readonly first?: Readonly<Record<string, unknown>>;
  /** Called once when the connection ends or fails, not after `close()`. */
  onLost(listener: (error: Error) => void): void;
  /** Called with every `NOTIFY` this session hears once it has run `LISTEN` (the notification bus, spec §20.3). */
  onNotification(listener: (channel: string, payload: string) => void): void;
  close(): Promise<void>;
}

export interface SessionOptions {
  readonly applicationName?: string;
  /** How long `connect` may take before it fails; 10 s by default, so a re-take never hangs. */
  readonly connectTimeoutMs?: number;
  /** How long any one query may wait for its answer; unbounded by default. */
  readonly queryTimeoutMs?: number;
  /**
   * The session's first query, run in place of the plain pid read, so a caller that has one more question to
   * ask pays one round trip and one query timeout, not two. It must return `pid` (`pg_backend_pid()`).
   */
  readonly first?: { readonly text: string; readonly params?: readonly unknown[] };
}

/**
 * TCP keepalive is on, so a connection a NAT or a failover dropped while idle ends with an error instead of
 * staying half-open for ever.
 */
export async function openSession(connectionString: string, options: SessionOptions = {}): Promise<Session> {
  const client = new pg.Client({
    connectionString,
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
    connectionTimeoutMillis: options.connectTimeoutMs ?? 10_000,
    application_name: options.applicationName ?? 'wirebench-session',
    ...(options.queryTimeoutMs !== undefined ? { query_timeout: options.queryTimeoutMs } : {}),
  });
  await client.connect();
  let pidRow: pg.QueryResult<{ pid: number } & Record<string, unknown>>;
  try {
    pidRow = await client.query<{ pid: number } & Record<string, unknown>>(
      options.first?.text ?? 'select pg_backend_pid() as pid',
      options.first?.params === undefined ? undefined : [...options.first.params],
    );
  } catch (error) {
    await client.end().catch(() => undefined);
    throw error;
  }
  let closed = false;
  let lost: ((error: Error) => void) | undefined;
  let fired = false;
  const fire = (error: Error) => {
    if (closed || fired) return;
    fired = true;
    lost?.(error);
  };
  client.on('error', (error) => fire(error));
  client.on('end', () => fire(new Error('the connection ended')));
  let heard: ((channel: string, payload: string) => void) | undefined;
  client.on('notification', (message) => {
    if (!closed) heard?.(message.channel, message.payload ?? '');
  });
  return {
    ...querierOf(client),
    pid: pidRow.rows[0]!.pid,
    ...(options.first !== undefined ? { first: pidRow.rows[0]! } : {}),
    onLost(listener) {
      lost = listener;
    },
    onNotification(listener) {
      heard = listener;
    },
    async close() {
      closed = true;
      await client.end().catch(() => undefined);
    },
  };
}

/** One lock-pool connection, checked out for the length of a repository operation (hosted edition spec §20.4). */
export interface LockConnection extends Querier {
  /** Called once if the connection fails or ends while checked out. */
  onLost(listener: (error: Error) => void): void;
  /** Back to the pool, or, with `destroy`, closed: a connection in doubt never goes back. */
  release(destroy: boolean): void;
}

/** The repository lock's own pool: session-level advisory locks, so on a direct connection, never a pooler. */
export interface LockPool {
  /** How long a checkout and then a lock may each wait; the lock's `lock_timeout` is this. */
  readonly waitMs: number;
  /**
   * A connection, or a rejection with `code: 'pool-timeout'` once {@link waitMs} passed with every connection held.
   */
  acquire(): Promise<LockConnection>;
  close(): Promise<void>;
}

export interface LockPoolOptions {
  /** At most this many connections, so at most this many locks held at once by the process (8 in the server). */
  readonly max: number;
  readonly applicationName: string;
  readonly waitMs: number;
  /** Told when an idle connection fails, never with the connection string. */
  readonly onError?: (error: Error) => void;
}

const POOL_TIMEOUT = /timeout exceeded when trying to connect/i;

/**
 * A `pg.Pool` for the repository lock (spec §20.4). `lock_timeout` is set on every connection at start-up, so a lock
 * wait past {@link LockPoolOptions.waitMs} fails in the server itself (`55P03`) and never goes on to take the lock;
 * TCP keepalive is on, so a connection a failover dropped ends with an error rather than staying half-open.
 */
export function createLockPool(connectionString: string, options: LockPoolOptions): LockPool {
  const pool = new pg.Pool({
    connectionString,
    max: options.max,
    application_name: options.applicationName,
    connectionTimeoutMillis: options.waitMs,
    lock_timeout: options.waitMs,
    // `pg` (over `net.Socket.setKeepAlive`) sets only the first probe's delay; the probe interval and count are the
    // operating system's. A half-open connection is caught sooner by the lock's own probe (`repo-lock.ts`).
    keepAlive: true,
    keepAliveInitialDelayMillis: 10_000,
  });
  pool.on('error', (error) => options.onError?.(error));
  return {
    waitMs: options.waitMs,
    async acquire() {
      let client: pg.PoolClient;
      try {
        client = await pool.connect();
      } catch (error) {
        if (error instanceof Error && POOL_TIMEOUT.test(error.message)) {
          throw Object.assign(new Error('every repository-lock connection is held'), { code: 'pool-timeout' });
        }
        throw error;
      }
      let listener: ((error: Error) => void) | undefined;
      let fired = false;
      const fire = (error: Error): void => {
        if (fired) return;
        fired = true;
        listener?.(error);
      };
      // A checked-out client has no pool listener: without one, a terminated backend's `error` would crash the process.
      const onError = (error: Error): void => fire(error);
      const onEnd = (): void => fire(new Error('the connection ended'));
      client.on('error', onError);
      client.on('end', onEnd);
      let released = false;
      return {
        ...querierOf(client),
        onLost(next) {
          listener = next;
        },
        release(destroy) {
          if (released) return;
          released = true;
          client.off('error', onError);
          client.off('end', onEnd);
          client.release(destroy || fired ? new Error('the repository-lock connection is in doubt') : undefined);
        },
      };
    },
    close: () => pool.end(),
  };
}
