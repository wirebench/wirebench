import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';
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
