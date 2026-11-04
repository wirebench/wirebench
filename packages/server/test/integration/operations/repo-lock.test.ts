/**
 * Slice 5 Task 7 (hosted edition spec §20.4): the advisory repository lock. Two repository stores on one database
 * stand for two instances: they serialise one workspace and not two, and two tenants with one workspace id never
 * block each other. A wait past the limit is `503 repo-busy` and never takes the lock later; a killed lock
 * connection ends `fn` with `repo-lock-lost` at its next git step; the lock is never left held after `fn` throws,
 * and `drain()` waits for a held lock.
 */
import { randomUUID } from 'node:crypto';
import { createServer, connect, type Server, type Socket } from 'node:net';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { SyncPushResponse } from '@wirebench/engine';
import { createLockPool, openSession, type LockPool } from '../../../src/db/pool.js';
import {
  assertRepoLockHeld,
  DatabaseRepoLock,
  guardGit,
  REPO_LOCK_CLASS,
  REPO_LOCK_PROBE_MS,
} from '../../../src/operations/repo-lock.js';
import { NO_HOOKS_DIR, RepoStore } from '../../../src/repos/repo-store.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir, testGit } from '../../helpers/git.js';
import { syncFixture } from '../../helpers/sync.js';
import { call } from '../../helpers/teams.js';

const TENANT = scopeOf({ id: randomUUID(), slug: 'acme' });
const OTHER_TENANT = scopeOf({ id: randomUUID(), slug: 'globex' });
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
const OTHER_WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QB';
const APP = 'wirebench-server-repo-lock-test';

/**
 * A TCP proxy to the test database whose `freeze()` black-holes both directions without closing anything: a
 * failover's half-open socket, which gives the client no error.
 */
async function freezingProxy(target: string): Promise<{
  readonly url: string;
  freeze(): void;
  close(): Promise<void>;
}> {
  const upstream = new URL(target);
  let frozen = false;
  const sockets = new Set<Socket>();
  const server: Server = createServer((client) => {
    const remote = connect(Number(upstream.port || 5432), upstream.hostname);
    for (const socket of [client, remote]) {
      sockets.add(socket);
      socket.on('error', () => undefined);
      socket.on('close', () => sockets.delete(socket));
    }
    client.on('data', (chunk) => {
      if (!frozen) remote.write(chunk);
    });
    remote.on('data', (chunk) => {
      if (!frozen) client.write(chunk);
    });
    client.on('end', () => remote.end());
    remote.on('end', () => client.end());
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  const url = new URL(target);
  url.hostname = '127.0.0.1';
  url.port = String(port);
  return {
    url: url.toString(),
    freeze: () => {
      frozen = true;
    },
    close: async () => {
      for (const socket of sockets) socket.destroy();
      await new Promise((resolve) => server.close(resolve));
    },
  };
}

/** A promise and its resolver, for holding `fn` open. */
function gate(): { readonly open: () => void; readonly wait: Promise<void> } {
  let open!: () => void;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { open, wait };
}

describeDb('the advisory repository lock (hosted spec §20.4)', () => {
  let db: TestDatabase;
  let dataDir: string;
  const pools: LockPool[] = [];
  beforeEach(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir();
    await RepoStore.prepare(dataDir);
  });
  afterEach(async () => {
    for (const pool of pools.splice(0)) await pool.close();
    await db.close();
    await removeTempDir(dataDir);
  });

  /** One instance's repository store: its own lock pool on the test schema. */
  const instance = (waitMs = 5_000): RepoStore => {
    const pool = createLockPool(db.url, { max: 8, applicationName: APP, waitMs });
    pools.push(pool);
    const git = guardGit(testGit(join(dataDir, NO_HOOKS_DIR)));
    return new RepoStore({ git, dataDir, lock: new DatabaseRepoLock({ pool }) });
  };

  /** The repository locks this file's lock pools hold right now (other files may hold their own). */
  const held = async (): Promise<number> => {
    const { rows } = await db.query<{ n: number }>(
      `select count(*)::int as n from pg_locks where locktype = 'advisory' and granted
         and classid::bigint = ($1::bigint & 4294967295) and objsubid = 2
         and pid in (select pid from pg_stat_activity where application_name = $2)`,
      [REPO_LOCK_CLASS, APP],
    );
    return rows[0]!.n;
  };

  it('two stores serialise one workspace, and not two', async () => {
    const a = instance();
    const b = instance();
    const order: string[] = [];
    const first = gate();
    const aHolds = a.withLock(TENANT, WS, async () => {
      order.push('a start');
      await first.wait;
      order.push('a end');
    });
    await vi.waitFor(async () => expect(await held()).toBe(1));
    const bSame = b.withLock(TENANT, WS, () => {
      order.push('b same');
      return Promise.resolve();
    });
    // Another workspace on the other store does not wait for `a`.
    await b.withLock(TENANT, OTHER_WS, () => {
      order.push('b other');
      return Promise.resolve();
    });
    expect(order).toEqual(['a start', 'b other']);
    first.open();
    await Promise.all([aHolds, bSame]);
    expect(order).toEqual(['a start', 'b other', 'a end', 'b same']);
    expect(await held()).toBe(0);
  });

  it('two tenants with the same workspace id do not block each other', async () => {
    const a = instance();
    const b = instance();
    const first = gate();
    const aHolds = a.withLock(TENANT, WS, () => first.wait);
    await vi.waitFor(async () => expect(await held()).toBe(1));
    expect(await b.withLock(OTHER_TENANT, WS, () => Promise.resolve('other tenant'))).toBe('other tenant');
    first.open();
    await aHolds;
  });

  it('a wait past the limit is 503 repo-busy with a retry, and never takes the lock afterwards', async () => {
    const a = instance();
    const b = instance(300);
    const first = gate();
    const aHolds = a.withLock(TENANT, WS, () => first.wait);
    await vi.waitFor(async () => expect(await held()).toBe(1));
    const ran = vi.fn(() => Promise.resolve());
    const refused = await b.withLock(TENANT, WS, ran).catch((error: unknown) => error);
    expect(refused).toMatchObject({ code: 'repo-busy', details: { status: 503, retryAfter: 5 } });
    expect(ran).not.toHaveBeenCalled();
    first.open();
    await aHolds;
    // The timed-out wait did not go on to take the lock once `a` let it go.
    await new Promise((resolve) => setTimeout(resolve, 100));
    expect(await held()).toBe(0);
    // And the store that timed out takes it normally next time.
    expect(await b.withLock(TENANT, WS, () => Promise.resolve('next'))).toBe('next');
  });

  it('a killed lock connection ends fn with repo-lock-lost at its next git step', async () => {
    const a = instance();
    const git = guardGit(testGit(join(dataDir, NO_HOOKS_DIR)));
    const outcome = a.withLock(TENANT, WS, async () => {
      assertRepoLockHeld();
      const killer = await openSession(db.url);
      try {
        await killer.query(
          `select pg_terminate_backend(pid) from pg_stat_activity where application_name = $1 and pid <> pg_backend_pid()`,
          [APP],
        );
      } finally {
        await killer.close();
      }
      await vi.waitFor(() => expect(() => assertRepoLockHeld()).toThrow());
      await git.run(dataDir, ['--version']);
      return 'went on';
    });
    await expect(outcome).rejects.toMatchObject({ code: 'repo-lock-lost', details: { status: 503 } });
    expect(await held()).toBe(0);
    // The store takes the lock again on a fresh connection.
    expect(await a.withLock(TENANT, WS, () => Promise.resolve('again'))).toBe('again');
  });

  it('a half-open lock connection (a failover) fails the next git step repo-lock-lost within seconds', async () => {
    const proxy = await freezingProxy(db.url);
    const pool = createLockPool(proxy.url, { max: 8, applicationName: APP, waitMs: 5_000 });
    pools.push(pool);
    const warned: string[] = [];
    const lock = new DatabaseRepoLock({ pool, warn: (_error, message) => warned.push(message) });
    const store = new RepoStore({ git: guardGit(testGit(join(dataDir, NO_HOOKS_DIR))), dataDir, lock });
    const git = guardGit(testGit(join(dataDir, NO_HOOKS_DIR)));
    try {
      // An ordinary step after the probe interval: the probe finds no answer.
      const ordinary = store.withLock(TENANT, WS, async () => {
        await git.run(dataDir, ['--version']);
        proxy.freeze();
        await new Promise((resolve) => setTimeout(resolve, REPO_LOCK_PROBE_MS + 50));
        const started = performance.now();
        const step = await git.run(dataDir, ['--version']).catch((error: unknown) => error);
        return { step, ms: performance.now() - started };
      });
      const { step, ms } = await ordinary;
      expect(step).toMatchObject({ code: 'repo-lock-lost', details: { status: 503 } });
      expect(ms).toBeLessThan(4_000);
      expect(warned).toEqual(['a repository lock connection was lost while its operation ran']);
    } finally {
      await proxy.close();
    }
    // The frozen connection is gone, so is its lock: another instance takes it.
    await vi.waitFor(async () => expect(await held()).toBe(0), { timeout: 10_000 });
    expect(await instance().withLock(TENANT, WS, () => Promise.resolve('taken'))).toBe('taken');
  });

  it('a ref update is always probed first, even within the probe interval', async () => {
    const proxy = await freezingProxy(db.url);
    const pool = createLockPool(proxy.url, { max: 8, applicationName: APP, waitMs: 5_000 });
    pools.push(pool);
    const store = new RepoStore({
      git: guardGit(testGit(join(dataDir, NO_HOOKS_DIR))),
      dataDir,
      lock: new DatabaseRepoLock({ pool, probeTimeoutMs: 500 }),
    });
    const git = guardGit(testGit(join(dataDir, NO_HOOKS_DIR)));
    try {
      const outcome = store.withLock(TENANT, WS, async () => {
        proxy.freeze();
        // Within the interval an ordinary step is not probed; the ref update is, and never runs.
        await git.run(dataDir, ['--version']);
        await git.run(dataDir, ['update-ref', 'refs/heads/main', 'HEAD']);
        return 'moved';
      });
      await expect(outcome).rejects.toMatchObject({ code: 'repo-lock-lost' });
    } finally {
      await proxy.close();
    }
    await vi.waitFor(async () => expect(await held()).toBe(0), { timeout: 10_000 });
  });

  it('the lock is never left held after fn throws', async () => {
    const a = instance();
    const b = instance();
    await expect(a.withLock(TENANT, WS, () => Promise.reject(new Error('boom')))).rejects.toThrow('boom');
    expect(await held()).toBe(0);
    expect(await b.withLock(TENANT, WS, () => Promise.resolve('free'))).toBe('free');
  });

  it('drain() waits for a held database lock to be released', async () => {
    const a = instance();
    const first = gate();
    const aHolds = a.withLock(TENANT, WS, () => first.wait);
    await vi.waitFor(async () => expect(await held()).toBe(1));
    let drained = false;
    const draining = a.drain().then(() => {
      drained = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 50));
    expect(drained).toBe(false);
    first.open();
    await draining;
    await aHolds;
    expect(await held()).toBe(0);
  });

  it('a push that waits past the limit answers 503 repo-busy with Retry-After: 5', async () => {
    const f = await syncFixture({ repoLock: { waitMs: 300 } });
    const pool = createLockPool(f.h.db.url, { max: 1, applicationName: APP, waitMs: 5_000 });
    pools.push(pool);
    const other = new RepoStore({
      git: testGit(join(f.h.dataDir, NO_HOOKS_DIR)),
      dataDir: f.h.dataDir,
      lock: new DatabaseRepoLock({ pool }),
    });
    const first = gate();
    try {
      const holds = other.withLock(f.h.tdb.scope, f.workspaceId, () => first.wait);
      await new Promise((resolve) => setTimeout(resolve, 100));
      const res = await f.h.app.inject({
        method: 'POST',
        url: `/api/v1/workspaces/${f.workspaceId}/sync/commits`,
        headers: f.editor.headers,
        payload: {
          parent: null,
          commits: [
            {
              subject: 'One',
              at: '2026-09-24T12:00:00.000Z',
              changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'a\n' }],
            },
          ],
        },
      });
      expect(res.statusCode).toBe(503);
      expect(res.headers['retry-after']).toBe('5');
      expect(res.json()).toMatchObject({ code: 'repo-busy' });
      first.open();
      await holds;
      const ok = await call<SyncPushResponse>(f.h, f.editor, 'POST', `/workspaces/${f.workspaceId}/sync/commits`, {
        parent: null,
        commits: [
          {
            subject: 'One',
            at: '2026-09-24T12:00:00.000Z',
            changes: [{ path: 'workspace.yaml', encoding: 'utf8', content: 'a\n' }],
          },
        ],
      });
      expect(ok.status).toBe(201);
    } finally {
      first.open();
      await f.h.close();
    }
  });
});
