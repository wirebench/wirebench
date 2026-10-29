import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';
import type { Database } from '../../src/context.js';
import { migrate, type Migration } from '../../src/db/migrate.js';
import { createDatabase } from '../../src/db/pool.js';
import { BUILTIN_MODULES } from '../../src/modules.js';
import { allMigrations } from '../../src/serve.js';
import { appRoleGrants } from '../../src/tenancy/grants.js';

/** The admin URL: a superuser, used only to create and drop each file's schema. */
export const TEST_DATABASE_URL = process.env.WIREBENCH_SERVER_TEST_DATABASE_URL;

/**
 * The two roles of spec §19.4 (`scripts/ci/server-test-roles.sql` creates them): the owner owns each
 * file's schema and runs its migrations; the app role runs every query, and row-level security applies
 * to it. Their URLs default to the admin URL with the roles' fixed test credentials.
 */
export const OWNER_ROLE = 'wirebench_owner';
export const APP_ROLE = 'wirebench_app';

function roleUrl(override: string | undefined, role: string): string | undefined {
  if (override !== undefined) return override;
  if (TEST_DATABASE_URL === undefined) return undefined;
  const url = new URL(TEST_DATABASE_URL);
  url.username = role;
  url.password = role;
  return url.toString();
}

const OWNER_URL = roleUrl(process.env.WIREBENCH_SERVER_TEST_OWNER_URL, OWNER_ROLE);
const APP_URL = roleUrl(process.env.WIREBENCH_SERVER_TEST_APP_URL, APP_ROLE);

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
    'WIREBENCH_SERVER_TEST_DATABASE_URL is unset; server integration tests are skipped (docker compose -f packages/server/compose.yaml up -d db, then psql the roles in scripts/ci/server-test-roles.sql)',
  );
  return describe.skip;
})();

export interface TestDatabase extends Database {
  readonly schema: string;
  /** The app role's URL with this schema on its search path: what a server under test connects with. */
  readonly url: string;
  /** The owner's URL, for a test that runs migrations through the server (`migrate`, a start-up). */
  readonly ownerUrl: string;
  /** The schema's owner. Only for migrations and for DDL a test makes; queries go through the app role. */
  readonly owner: Database;
  /** Runs `migrations` as the owner, then grants the app role what the server's app role holds. */
  migrate(migrations: readonly Migration[]): Promise<void>;
  /** Grants the app role what the server's app role holds, after the server migrated at `ownerUrl`. */
  grant(): Promise<void>;
}

function withSchema(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

/**
 * A fresh schema per test file so files run in parallel; dropped on close. The admin creates it,
 * `authorization wirebench_owner`; the owner migrates it with every built-in module's migrations and
 * grants the app role its privileges (`appRoleGrants`, the list `ensureAppRole` applies in production).
 * The returned database queries as the app role.
 *
 * With `{ migrated: false }` the schema is left empty, for a suite that migrates it itself: through
 * `migrate` (as the owner, then the grants), or through the server at `ownerUrl`.
 */
export async function testDatabase(options: { readonly migrated?: boolean } = {}): Promise<TestDatabase> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createDatabase(TEST_DATABASE_URL!);
  await admin.query(`create schema ${schema} authorization ${OWNER_ROLE}`);
  await admin.close();
  const ownerUrl = withSchema(OWNER_URL!, schema);
  const url = withSchema(APP_URL!, schema);
  const owner = createDatabase(ownerUrl);
  const db = createDatabase(url);
  const grant = async (): Promise<void> => {
    for (const statement of appRoleGrants({ schema, owner: OWNER_ROLE, app: APP_ROLE })) {
      await owner.query(statement);
    }
  };
  const close = async (): Promise<void> => {
    await db.close();
    await owner.close();
    const cleanup = createDatabase(TEST_DATABASE_URL!);
    await cleanup.query(`drop schema ${schema} cascade`);
    await cleanup.close();
  };
  try {
    await grant();
    if (options.migrated !== false) {
      await migrate(owner, await allMigrations(BUILTIN_MODULES));
      await grant();
    }
  } catch (error) {
    await close();
    throw error;
  }
  return {
    ...db,
    schema,
    url,
    ownerUrl,
    owner,
    migrate: async (migrations) => {
      await migrate(owner, migrations);
      await grant();
    },
    grant,
    close,
  };
}
