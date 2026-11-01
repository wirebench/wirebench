import { randomBytes } from 'node:crypto';
import { describe } from 'vitest';
import type { Database } from '../../src/db/querier.js';
import { migrate, type Migration } from '../../src/db/migrate.js';
import { createDatabase } from '../../src/db/pool.js';
import { BUILTIN_MODULES } from '../../src/modules.js';
import { allMigrations } from '../../src/serve.js';
import { ensureAppRole } from '../../src/tenancy/roles.js';
import { sqlSkeleton } from '../../src/tenancy/tenant-db.js';
import { SCOPED_TABLES } from './catalog.js';

/** The admin URL: a superuser, used only to create and drop each file's schema. */
export const TEST_DATABASE_URL =
  process.env.WIREBENCH_SERVER_TEST_DATABASE_URL === '' ? undefined : process.env.WIREBENCH_SERVER_TEST_DATABASE_URL;

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

const ROLES_HINT = 'create the test roles: psql the superuser URL -f scripts/ci/server-test-roles.sql';

/**
 * Whether the database suites run. With no database URL they skip, saying how to get one, unless
 * `WIREBENCH_SERVER_REQUIRE_DB=1` (CI's server-integration job), where a lost URL must fail the job rather
 * than skip every suite, the role test included, and pass green.
 */
export function databaseSuites(env: NodeJS.ProcessEnv): 'run' | 'skip' {
  if (env.WIREBENCH_SERVER_TEST_DATABASE_URL !== undefined && env.WIREBENCH_SERVER_TEST_DATABASE_URL !== '') {
    return 'run';
  }
  if (env.WIREBENCH_SERVER_REQUIRE_DB === '1') {
    throw new Error('WIREBENCH_SERVER_REQUIRE_DB=1 but WIREBENCH_SERVER_TEST_DATABASE_URL is unset');
  }
  return 'skip';
}

/**
 * `describe` that skips, saying how to get a database, when none is configured (see `databaseSuites`).
 *
 * Typed as the narrower `(name, factory) => void` rather than `typeof describe`: vitest 5's
 * `SuiteAPI` type has `describe` and `describe.skip` structurally incompatible (their `skipIf`/
 * `runIf` chain types differ), so assigning either branch to a `typeof describe`-typed const
 * fails to typecheck. Only the plain two-argument call form is used here.
 */
export const describeDb: (name: string, factory: () => void) => void = (() => {
  if (databaseSuites(process.env) === 'run') return describe;
  console.warn(
    `WIREBENCH_SERVER_TEST_DATABASE_URL is unset; server integration tests are skipped (docker compose -f packages/server/compose.yaml up -d db, then ${ROLES_HINT})`,
  );
  return describe.skip;
})();

const NAMES_SCOPED_TABLE = new RegExp(`\\b(?:${SCOPED_TABLES.join('|')})\\b`, 'i');
const SETS_TENANT = /set_config\s*\(\s*'wirebench\.tenant_id'/i;

/**
 * The app role's pool, refusing a statement that names a scoped table outside a tenant unit (Task 17). Under the
 * forced policy such a statement reads nothing and writes nothing, so a test that asserted on it would pass for
 * nothing, and a server path that sent one would fail silently. A unit is a transaction whose `set_config` of
 * `wirebench.tenant_id` came first, as `withTenant` sends it; a test writes its fixtures through one (`tdb`).
 */
function outsideUnitsRefused(db: Database): Database {
  const refused = (text: string): Error | undefined =>
    NAMES_SCOPED_TABLE.test(sqlSkeleton(text))
      ? new Error(`a statement on a scoped table ran outside a tenant unit; send it through a TenantDb: ${text}`)
      : undefined;
  return {
    query: (text: string, params?: readonly unknown[]) => {
      const error = refused(text);
      return error === undefined ? db.query(text, params) : Promise.reject(error);
    },
    transaction: (fn) =>
      db.transaction((tx) => {
        let inUnit = false;
        return fn({
          query: (text: string, params?: readonly unknown[]) => {
            if (SETS_TENANT.test(text)) inUnit = true;
            const error = inUnit ? undefined : refused(text);
            return error === undefined ? tx.query(text, params) : Promise.reject(error);
          },
        });
      }),
    close: () => db.close(),
  };
}

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

/** A missing role (`42704`) or a refused sign-in (`28P01`, `28000`) means the roles script has not run. */
function withRolesHint(error: unknown): never {
  const code = (error as { readonly code?: unknown }).code;
  if (code === '42704' || code === '28P01' || code === '28000') {
    throw new Error(`${error instanceof Error ? error.message : String(error)}; ${ROLES_HINT}`, { cause: error });
  }
  throw error;
}

function withSchema(base: string, schema: string): string {
  const url = new URL(base);
  url.searchParams.set('options', `-c search_path=${schema}`);
  return url.toString();
}

/**
 * A fresh schema per test file so files run in parallel; dropped on close. The admin creates it,
 * `authorization wirebench_owner`; the owner migrates it with every built-in module's migrations and
 * runs `ensureAppRole`, as `serve` does with two URLs. The returned database queries as the app role.
 *
 * With `{ migrated: false }` the schema is left empty and nothing is granted, for a suite that migrates
 * it itself: through `migrate` (as the owner, then the grants), or through the server at `ownerUrl`.
 */
export async function testDatabase(options: { readonly migrated?: boolean } = {}): Promise<TestDatabase> {
  const schema = `t_${randomBytes(6).toString('hex')}`;
  const admin = createDatabase(TEST_DATABASE_URL!);
  try {
    await admin.query(`create schema ${schema} authorization ${OWNER_ROLE}`).catch(withRolesHint);
  } finally {
    await admin.close();
  }
  const ownerUrl = withSchema(OWNER_URL!, schema);
  const url = withSchema(APP_URL!, schema);
  const owner = createDatabase(ownerUrl);
  const db = outsideUnitsRefused(createDatabase(url));
  const grant = async (): Promise<void> => {
    await ensureAppRole(owner, url);
  };
  const close = async (): Promise<void> => {
    await db.close();
    await owner.close();
    const cleanup = createDatabase(TEST_DATABASE_URL!);
    await cleanup.query(`drop schema ${schema} cascade`);
    await cleanup.close();
  };
  try {
    await owner.query('select 1').catch(withRolesHint);
    await db.query('select 1').catch(withRolesHint);
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
