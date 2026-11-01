/**
 * Start-up's file step runs on the migration URL's own pool, which is closed once the step is done (Task 22 fix round
 * 2 review m4). A failure to close it is reported as itself, not as a data directory that could not be moved, and the
 * start-up's error path neither closes that pool a second time nor skips closing the app's pool.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { Database } from '../../../src/db/querier.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, StartupError } from '../../../src/serve.js';
import { readTenancyStep } from '../../../src/tenancy/file-step.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

/** Every pool start-up made, with how often each was closed; the migration URL's is made with no options. */
const made = vi.hoisted(() => [] as { owner: boolean; closes: number }[]);
/** Only start-up's pools are watched; the test database's own helpers use the real ones. */
const armed = vi.hoisted(() => ({ on: false }));

vi.mock('../../../src/db/pool.js', async (importOriginal) => {
  const real = await importOriginal<typeof import('../../../src/db/pool.js')>();
  return {
    ...real,
    createDatabase: (url: string, options?: Parameters<typeof real.createDatabase>[1]): Database => {
      const db = real.createDatabase(url, options);
      if (!armed.on) return db;
      const entry = { owner: options === undefined, closes: 0 };
      made.push(entry);
      return {
        ...db,
        close: async () => {
          entry.closes++;
          await db.close();
          if (entry.owner) throw new Error('the pool did not end');
        },
      };
    },
  };
});

describeDb('the file step on the migration connection', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  beforeEach(async () => {
    made.length = 0;
    db = await testDatabase();
    dataDir = await mkTempDir('wbs-step-owner-close-');
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('reports a failure to close it as itself, and closes every pool once (round 2 review m4)', async () => {
    const env = {
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    };
    armed.on = true;
    const error = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      { signals: new EventEmitter(), exit: vi.fn(), modules: BUILTIN_MODULES },
    )
      .catch((caught: unknown) => caught)
      .finally(() => {
        armed.on = false;
      });
    expect(error).toBeInstanceOf(StartupError);
    expect((error as Error).message).toBe(
      'the migration connection did not close after the tenancy step: the pool did not end',
    );
    expect((error as Error).message).not.toContain('could not be moved');
    // The step itself ran and committed.
    expect((await readTenancyStep(db.owner))?.step).toBe('keys');
    // One app pool and one migration pool, each closed exactly once.
    expect(
      made.map(({ owner, closes }) => ({ owner, closes })).sort((a, b) => Number(a.owner) - Number(b.owner)),
    ).toEqual([
      { owner: false, closes: 1 },
      { owner: true, closes: 1 },
    ]);
  });
});
