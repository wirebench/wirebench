/**
 * Test helpers for the tenant database (spec §19.13): `statementLog()` records each statement with the tenant its
 * unit set first, and `expectAllScoped` checks it. Modules have no `ctx.db` since 0021 (Task 17), so every
 * statement they send goes through a unit; the log shows it is the right tenant's.
 */
import { expect } from 'vitest';
import type { Database, Querier } from '../../src/db/querier.js';
import { TenantDirectory } from '../../src/tenancy/directory.js';
import {
  tenantDbFactory,
  type StatementLogEntry,
  type TenantDb,
  type TenantQuerier,
} from '../../src/tenancy/tenant-db.js';
import { environmentKeyRoot } from '../../src/tenancy/keys.js';
import { createTenancy, type Tenancy } from '../../src/tenancy/tenancy.js';

export interface StatementLog {
  readonly entries: StatementLogEntry[];
  readonly onStatement: (entry: StatementLogEntry) => void;
}

export function statementLog(): StatementLog {
  const entries: StatementLogEntry[] = [];
  return { entries, onStatement: (entry) => entries.push(entry) };
}

/** The default tenant's database over `db`: for a suite that writes fixtures through a moved repository. */
export async function defaultTenantDb(db: Database): Promise<TenantDb> {
  const directory = new TenantDirectory(db);
  if (!(await directory.load())) throw new Error('this schema has no tenants: migrate it first');
  return tenantDbFactory(db)(directory.defaultScope());
}

/**
 * Test only: a plain querier passed where a repository takes a tenant one, for a test that reads the SQL a
 * repository sends (an `explain`) rather than running it in a unit.
 */
export function asTenantQuerier(querier: Querier): TenantQuerier {
  return querier as TenantQuerier;
}

/** A tenancy over `db` that records every statement. */
export function loggedTenancy(db: Database, root?: Buffer): { readonly tenancy: Tenancy; readonly log: StatementLog } {
  const log = statementLog();
  return {
    tenancy: createTenancy(db, {
      onStatement: log.onStatement,
      ...(root !== undefined ? { keyRoot: environmentKeyRoot(root) } : {}),
    }),
    log,
  };
}

/**
 * Every statement ran in a unit whose `set_config` came first and named `tenantId`. At least one statement must
 * be in the log, so a fill that wrote nothing does not pass.
 */
export function expectAllScoped(log: StatementLog, tenantId: string): void {
  const set = new Map<number, string>();
  let statements = 0;
  for (const entry of log.entries) {
    if (entry.kind === 'set-config') set.set(entry.unit, entry.tenantId);
    else {
      statements++;
      // Read as the statement is reached, so a set_config logged after it does not count.
      expect(set.get(entry.unit), entry.text).toBe(tenantId);
    }
  }
  expect(statements, 'statements in the log').toBeGreaterThan(0);
}
