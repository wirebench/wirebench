import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database, ServerModule } from '../../../src/context.js';
import { createDatabase, openSession, type Session } from '../../../src/db/pool.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import { RunningLock, SERVER_RUNNING_CLASS, TRY_EXCLUSIVE } from '../../../src/tenancy/running-lock.js';
import { describeDb, TEST_DATABASE_URL, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

/** Every built-in module's migrations, and none of its routes: what a start-up here needs. */
const MIGRATIONS_ONLY: readonly ServerModule[] = BUILTIN_MODULES.map((m) => ({
  name: m.name,
  ...(m.migrationsDir !== undefined ? { migrationsDir: m.migrationsDir } : {}),
  register: () => Promise.resolve(),
}));

/** Plan Task 5: the server-running lock (spec §19.10) and the start-up warning (§19.4). */
describeDb('the server-running lock and the start-up checks (hosted spec §19.4, §19.10)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDirs: string[];
  let revert: Session;
  // Only a superuser may end another role's backend.
  let admin: Database;
  beforeEach(async () => {
    db = await testDatabase();
    dataDirs = [];
    revert = await openSession(db.url);
    admin = createDatabase(TEST_DATABASE_URL!);
  });
  afterEach(async () => {
    await admin.close();
    await revert.close();
    await db.close();
    for (const dir of dataDirs) await removeTempDir(dir);
  });

  /** What `admin tenancy revert` will try: the lock, exclusively, released at once when taken. */
  const revertCanStart = async () => {
    const ok = (await revert.query<{ ok: boolean }>(TRY_EXCLUSIVE, [SERVER_RUNNING_CLASS])).rows[0]!.ok;
    if (ok) await revert.query('select pg_advisory_unlock($1, hashtext(current_schema()))', [SERVER_RUNNING_CLASS]);
    return ok;
  };

  const start = async (url: string, lines?: string[]): Promise<RunningServer> => {
    const dataDir = await mkTempDir();
    dataDirs.push(dataDir);
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'warn',
    };
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines?.push(chunk.toString('utf8'));
        done();
      },
    });
    return startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        logStream,
        modules: MIGRATIONS_ONLY,
      },
    );
  };

  it('lets two servers start on one database, each holding it shared, and refuses a revert while either runs', async () => {
    expect(await revertCanStart()).toBe(true);
    const first = await start(db.url);
    const second = await start(db.url);
    try {
      expect(await revertCanStart()).toBe(false);
      await first.close();
      expect(await revertCanStart()).toBe(false);
    } finally {
      await first.close();
      await second.close();
    }
    expect(await revertCanStart()).toBe(true);
  });

  it('refuses to start with tenancy-reverting while a revert holds it', async () => {
    expect((await revert.query<{ ok: boolean }>(TRY_EXCLUSIVE, [SERVER_RUNNING_CLASS])).rows[0]!.ok).toBe(true);
    await expect(start(db.url)).rejects.toMatchObject({
      exitCode: 2,
      message: expect.stringContaining('tenancy-reverting') as unknown,
    });
  });

  it('takes the lock again on a new connection when its connection drops', async () => {
    const retaken = vi.fn();
    const lost = vi.fn();
    const lock = await RunningLock.acquire(db.url, { onLost: lost, onRetaken: retaken, retryDelayMs: 50 });
    try {
      const pid = lock.pid!;
      await admin.query('select pg_terminate_backend($1)', [pid]);
      await vi.waitFor(() => expect(retaken).toHaveBeenCalled(), { timeout: 5000, interval: 20 });
      expect(lock.pid).not.toBe(pid);
      expect(lost).not.toHaveBeenCalled();
      expect(await revertCanStart()).toBe(false);
    } finally {
      await lock.release();
    }
    expect(await revertCanStart()).toBe(true);
  });

  it('gives up, and calls onLost, when a revert took it in the gap', async () => {
    const lost = vi.fn();
    const lock = await RunningLock.acquire(db.url, { onLost: lost, retryDelayMs: 20, retries: 3 });
    try {
      const pid = lock.pid!;
      await admin.query('select pg_terminate_backend($1)', [pid]);
      // Only the shared holder is gone: the exclusive try succeeds as soon as the backend has ended.
      await vi.waitFor(
        async () =>
          expect(
            await revert.query<{ ok: boolean }>(TRY_EXCLUSIVE, [SERVER_RUNNING_CLASS]).then((r) => r.rows[0]!.ok),
          ).toBe(true),
        {
          timeout: 5000,
          interval: 5,
        },
      );
      await vi.waitFor(() => expect(lost).toHaveBeenCalled(), { timeout: 5000, interval: 20 });
    } finally {
      await lock.release();
    }
  });

  it('warns at start-up, and starts, when the app role owns the tables (self-hosted, one role)', async () => {
    const lines: string[] = [];
    const server = await start(db.ownerUrl, lines);
    try {
      const warning = lines
        .map((line) => JSON.parse(line) as { level: number; msg: string })
        .find((line) => line.level === 40);
      expect(warning?.msg).toMatch(
        /wirebench_owner owns \d+ of the server's tables, so row-level security does not apply/,
      );
    } finally {
      await server.close();
    }
  });

  it('starts as the app role without that warning', async () => {
    const lines: string[] = [];
    const server = await start(db.url, lines);
    try {
      expect(lines.join('')).not.toContain('row-level security does not apply');
    } finally {
      await server.close();
    }
  });
});
