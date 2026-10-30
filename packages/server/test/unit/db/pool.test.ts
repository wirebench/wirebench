/**
 * `Database.transaction` over a stub pool (hosted edition spec §19.4; Task 5 review I4): a client in doubt is
 * released with an error, which makes `pg-pool` destroy it, and a clean one without. Against a real server the
 * dead client is dropped by `pg-pool` whatever `release` is given, so only a stub tells the two apart.
 */
import { describe, expect, it, vi } from 'vitest';
import { createDatabase, type PoolLike } from '../../../src/db/pool.js';

interface StubClient {
  readonly sent: string[];
  readonly release: ReturnType<typeof vi.fn>;
  readonly on: ReturnType<typeof vi.fn>;
  readonly off: ReturnType<typeof vi.fn>;
  query(text: string): Promise<{ rows: never[]; rowCount: number }>;
}

/** A client that answers every statement, fails the ones `failing` names, and never answers the ones `hanging` names. */
function stubClient(failing: readonly string[] = [], hanging: readonly string[] = []): StubClient {
  const client: StubClient = {
    sent: [],
    release: vi.fn(),
    on: vi.fn(),
    off: vi.fn(),
    query(text) {
      client.sent.push(text);
      if (hanging.includes(text)) return new Promise(() => undefined);
      return failing.includes(text)
        ? Promise.reject(new Error(`${text} failed`))
        : Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return client;
}

function over(client: StubClient) {
  const pool = {
    connect: () => Promise.resolve(client),
    query: vi.fn(),
    on: vi.fn(),
    end: () => Promise.resolve(),
  } as unknown as PoolLike;
  return createDatabase('postgres://stub', { pool });
}

describe('Database.transaction', () => {
  it('returns a clean client to the pool: release() with no error', async () => {
    const client = stubClient();
    expect(await over(client).transaction(() => Promise.resolve(7))).toBe(7);
    expect(client.sent).toEqual(['BEGIN', 'COMMIT']);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('returns a client whose unit threw but rolled back cleanly', async () => {
    const client = stubClient();
    await expect(over(client).transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(client.sent).toEqual(['BEGIN', 'ROLLBACK']);
    expect(client.release).toHaveBeenCalledExactlyOnceWith(undefined);
  });

  it('destroys a client that is still queryable but whose ROLLBACK failed', async () => {
    const client = stubClient(['ROLLBACK']);
    await expect(over(client).transaction(() => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(client.release).toHaveBeenCalledOnce();
    expect(client.release.mock.calls[0]![0]).toBeInstanceOf(Error);
    expect((client.release.mock.calls[0]![0] as Error).message).toBe('ROLLBACK failed');
  });

  it('destroys a client with a statement of the unit still out after COMMIT, without reading pg internals', async () => {
    const client = stubClient([], ['select pg_sleep(60)']);
    await over(client).transaction((tx) => {
      void tx.query('select pg_sleep(60)');
      return Promise.resolve();
    });
    expect((client.release.mock.calls[0]![0] as Error).message).toBe('the client is not idle after its unit');
  });

  it('reports a connection error through onError, and listens only for the length of the unit', async () => {
    const client = stubClient();
    const errors: Error[] = [];
    const pool = {
      connect: () => Promise.resolve(client),
      query: vi.fn(),
      on: vi.fn(),
      end: () => Promise.resolve(),
    } as unknown as PoolLike;
    const db = createDatabase('postgres://stub', { pool, onError: (error) => errors.push(error) });
    await db.transaction(() => {
      const listener = client.on.mock.calls[0]![1] as (error: Error) => void;
      listener(new Error('connection reset'));
      return Promise.resolve();
    });
    expect(errors.map((e) => e.message)).toEqual(['connection reset']);
    expect(client.off).toHaveBeenCalledWith('error', client.on.mock.calls[0]![1]);
  });
});
