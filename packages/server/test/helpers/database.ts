import { randomBytes } from 'node:crypto';
import { afterAll, beforeAll, describe } from 'vitest';
import type { Database } from '../../src/context.js';
import { createDatabase } from '../../src/db/pool.js';

export const TEST_DATABASE_URL = process.env.WIREBENCH_SERVER_TEST_DATABASE_URL;

/**
 * `describe` that skips, saying how to get a database, when none is configured.
 *
 * Typed as the narrower `(name, factory) => void` rather than `typeof describe`: vitest 5's
 * `SuiteAPI` type has `describe` and `describe.skip` structurally incompatible (their `skipIf`/
 * `runIf` chain types differ), so assigning either branch to a `typeof describe`-typed const
 * fails to typecheck. Only the plain two-argument call form is used here.
 */
export const describeDb: (name: string, factory: () => void) => void = (() => {
  if (TEST_DATABASE_URL !== undefined) return describe;
  console.warn(
    'WIREBENCH_SERVER_TEST_DATABASE_URL is unset; server integration tests are skipped (docker compose -f packages/server/compose.yaml up -d db)',
  );
  return describe.skip;
})();

/** A fresh schema per test file so files run in parallel; dropped on close. */
export async function testDatabase(): Promise<Database & { schema: string; url: string }> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const url = new URL(TEST_DATABASE_URL!);
  url.searchParams.set('options', `-c search_path=${schema}`);
  const admin = createDatabase(TEST_DATABASE_URL!);
  await admin.query(`create schema ${schema}`);
  await admin.close();
  const db = createDatabase(url.toString());
  return {
    ...db,
    schema,
    url: url.toString(),
    close: async () => {
      await db.close();
      const cleanup = createDatabase(TEST_DATABASE_URL!);
      await cleanup.query(`drop schema ${schema} cascade`);
      await cleanup.close();
    },
  };
}

/**
 * A test-only advisory lock id ("wbchtest"), never the audit chain's own. Advisory locks are
 * database-wide, while test files run in parallel on their own schemas: two files that take the chain's
 * lock would see each other's sealer passes and retention batches as `busy-elsewhere` or a wait.
 */
const CHAIN_TEST_FILES_LOCK_ID = 0x7762636874657374n;

/**
 * Holds {@link CHAIN_TEST_FILES_LOCK_ID} on its own connection until the returned release, so the files
 * that take the audit chain's advisory lock run one at a time. Call it from the file's `beforeAll`.
 */
export async function holdChainTestFiles(): Promise<() => Promise<void>> {
  const db = createDatabase(TEST_DATABASE_URL!);
  let release: () => void = () => undefined;
  const released = new Promise<void>((resolve) => {
    release = resolve;
  });
  let acquired: () => void = () => undefined;
  const held = new Promise<void>((resolve) => {
    acquired = resolve;
  });
  const transaction = db.transaction(async (tx) => {
    await tx.query('select pg_advisory_xact_lock($1::bigint)', [CHAIN_TEST_FILES_LOCK_ID.toString()]);
    acquired();
    await released;
  });
  // A failed connection rejects here rather than leaving the caller waiting.
  await Promise.race([held, transaction]);
  return async () => {
    release();
    await transaction;
    await db.close();
  };
}

/**
 * Registers file-level hooks that hold {@link holdChainTestFiles} for the whole file. Call it at the top
 * level of every test file that takes the audit chain's advisory lock; it does nothing without a database.
 */
export function oneChainTestFileAtATime(): void {
  let release: (() => Promise<void>) | undefined;
  // Waits while another chain file runs, so its timeout covers that file's whole run.
  beforeAll(async () => {
    if (TEST_DATABASE_URL !== undefined) release = await holdChainTestFiles();
  }, 600_000);
  afterAll(async () => {
    await release?.();
  });
}
