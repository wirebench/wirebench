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

/** A `pg.Pool` behind the `Database` interface; the one place `pg` is imported. */
export function createDatabase(connectionString: string): Database {
  const pool = new pg.Pool({ connectionString, max: 10 });
  return {
    ...querierOf(pool),
    async transaction(fn) {
      const client = await pool.connect();
      try {
        await client.query('BEGIN');
        const result = await fn(querierOf(client));
        await client.query('COMMIT');
        return result;
      } catch (error) {
        await client.query('ROLLBACK').catch(() => undefined);
        throw error;
      } finally {
        client.release();
      }
    },
    close: () => pool.end(),
  };
}
