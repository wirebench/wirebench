/**
 * The user profile's schema (migration 0026) on a database held at an older version. Since 0026 every user query
 * reads the username, the about text and the image versions, so a test that runs today's server over a schema it
 * keeps at 0020 or 0021 (the tenancy migration and revert suites) adds them first, outside the ledger, and drops them
 * before it compares that schema with an older one.
 */
import type { Querier } from '../../src/db/querier.js';
import { BUILTIN_MODULES } from '../../src/modules.js';
import { allMigrations } from '../../src/serve.js';

export const PROFILE_MIGRATION = 26;

/** Runs 0026's statements without recording them, so the ledger still says what the test holds the schema at. */
export async function addProfileSchema(owner: Querier): Promise<void> {
  const migration = (await allMigrations(BUILTIN_MODULES)).find((m) => m.version === PROFILE_MIGRATION);
  if (migration === undefined) throw new Error('no migration 0026');
  await owner.query(migration.sql);
}

/** Takes 0026's objects away again. */
export async function dropProfileSchema(owner: Querier): Promise<void> {
  await owner.query('drop table user_images');
  await owner.query(
    `alter table users drop constraint users_username_lower_key, drop constraint users_username_lower_check,
       drop column username, drop column username_lower, drop column about`,
  );
}
