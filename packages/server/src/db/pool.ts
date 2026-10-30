import pg from 'pg';
import type { Database, Querier } from '../context.js';

function querierOf(runner: { query(text: string, values?: unknown[]): Promise<pg.QueryResult> }): Querier {
  return {
    query: async (text, params) => {
      const result = await runner.query(text, params === undefined ? undefined : [...params]);
      return { rows: result.rows as never[], rowCount: result.rowCount };
    },
  };
}

/** What `pg` keeps on a client while a query runs or waits: undocumented, so read defensively. */
interface ClientInternals {
  readonly activeQuery?: unknown;
  readonly queryQueue?: readonly unknown[];
}

/** Whether `client` has nothing running and nothing queued: the only state fit to go back to the pool. */
export function isIdle(client: pg.PoolClient): boolean {
  const internals = client as unknown as ClientInternals;
  return (internals.activeQuery ?? null) === null && (internals.queryQueue?.length ?? 0) === 0;
}

export interface DatabaseOptions {
  /** The pool's size; 10 by default. Tests pass 1 to see what the next unit gets back. */
  readonly max?: number;
}

/** A `pg.Pool` behind the `Database` interface; the one place `pg` is imported. */
export function createDatabase(connectionString: string, options: DatabaseOptions = {}): Database {
  const pool = new pg.Pool({ connectionString, max: options.max ?? 10 });
  // A pooled client whose server end goes away while it is idle emits `error`; without a listener
  // that would crash the process. The pool drops the client itself.
  pool.on('error', () => undefined);
  return {
    ...querierOf(pool),
    async transaction(fn) {
      const client = await pool.connect();
      // A connection that fails mid-unit emits `error` on the client; the failed query rejects as well, and
      // the client is destroyed below, so the event itself needs no more than a listener.
      const onError = () => undefined;
      client.on('error', onError);
      // A client in doubt is destroyed, never reused (hosted edition spec §19.4): one whose rollback
      // failed may still be inside the transaction, and one that is not idle has a statement of this
      // unit still running. `release(error)` ends its connection instead of pooling it.
      let doubt: Error | undefined;
      try {
        await client.query('BEGIN');
        const result = await fn(querierOf(client));
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
        if (doubt === undefined && !isIdle(client)) doubt = new Error('the client is not idle after its unit');
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
  /** Called once when the connection ends or fails, not after `close()`. */
  onLost(listener: (error: Error) => void): void;
  close(): Promise<void>;
}

export async function openSession(connectionString: string): Promise<Session> {
  const client = new pg.Client({ connectionString });
  await client.connect();
  const pidRow = await client.query<{ pid: number }>('select pg_backend_pid() as pid');
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
  return {
    ...querierOf(client),
    pid: pidRow.rows[0]!.pid,
    onLost(listener) {
      lost = listener;
    },
    async close() {
      closed = true;
      await client.end().catch(() => undefined);
    },
  };
}
