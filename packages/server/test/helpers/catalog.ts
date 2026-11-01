/**
 * Readers of the server schema's catalog, for the tenancy migration test (hosted edition spec §19.8, guard 3)
 * and, later, the revert's round trip, which compares a reverted schema with the fixture's (§19.13).
 */
import type { Querier } from '../../src/db/querier.js';

/** The tables without `tenant_id` (spec §19.2). */
export const UNSCOPED_TABLES: readonly string[] = ['schema_migrations', 'server_identity', 'tenants'];

/** The 36 scoped tables (spec §19.3), as 0020 and 0021 name them. */
export const SCOPED_TABLES: readonly string[] = [
  'workspaces',
  'users',
  'local_credentials',
  'oidc_identities',
  'invitations',
  'device_tokens',
  'oidc_flows',
  'browser_flows',
  'teams',
  'team_members',
  'team_invitations',
  'workspace_grants',
  'license',
  'ci_tokens',
  'catch_urls',
  'captures',
  'schedules',
  'schedule_runs',
  'schedule_results',
  'schedule_alert_outbox',
  'audit_events',
  'audit_forward_queue',
  'audit_chain_anchor',
  'saml_identities',
  'saml_flows',
  'scim_tokens',
  'scim_users',
  'scim_groups',
  'scim_group_members',
  'provisioned_memberships',
  'session_logs',
  'session_log_chunks',
  'agent_pairings',
  'agent_pairing_codes',
  'agent_nonces',
  'host_leases',
];

export type ColumnInfo = {
  readonly table: string;
  readonly column: string;
  readonly type: string;
  readonly notNull: boolean;
  readonly default: string | null;
};

export type KeyInfo = {
  readonly table: string;
  readonly name: string;
  /** `p` primary key, `u` unique constraint, `f` foreign key, `i` a unique index that is no constraint. */
  readonly kind: 'p' | 'u' | 'f' | 'i';
  readonly columns: readonly string[];
  /** A foreign key's referenced table and columns. */
  readonly references?: { readonly table: string; readonly columns: readonly string[] };
  readonly definition: string;
};

export type IndexInfo = {
  readonly table: string;
  readonly name: string;
  readonly unique: boolean;
  readonly definition: string;
};

/** The ordinary tables of the current schema, by name. */
export async function tablesOf(db: Querier): Promise<string[]> {
  const rows = await db.query<{ table: string }>(
    'select tablename as table from pg_tables where schemaname = current_schema() order by 1',
  );
  return rows.rows.map((row) => row.table);
}

/** Every live column, in table order then column order. */
export async function columnsOf(db: Querier): Promise<ColumnInfo[]> {
  const rows = await db.query<ColumnInfo>(
    `select c.relname as table, a.attname as column, format_type(a.atttypid, a.atttypmod) as type,
        a.attnotnull as "notNull", pg_get_expr(d.adbin, d.adrelid) as default
      from pg_attribute a
      join pg_class c on c.oid = a.attrelid
      left join pg_attrdef d on d.adrelid = a.attrelid and d.adnum = a.attnum
      where c.relnamespace = to_regnamespace(current_schema()) and c.relkind = 'r' and a.attnum > 0
        and not a.attisdropped
      order by c.relname, a.attnum`,
  );
  return rows.rows;
}

/**
 * Primary keys, unique constraints, foreign keys, and unique indexes that back no constraint (`i`), with
 * their columns in key order. An expression column is shown as `(expr)`.
 */
export async function keysOf(db: Querier): Promise<KeyInfo[]> {
  const constraints = await db.query<{
    table: string;
    name: string;
    kind: 'p' | 'u' | 'f';
    columns: string[];
    refTable: string | null;
    refColumns: string[] | null;
    definition: string;
  }>(
    `select c.conrelid::regclass::text as table, c.conname as name, c.contype as kind,
        array(select a.attname::text from unnest(c.conkey) with ordinality k(n, o)
          join pg_attribute a on a.attrelid = c.conrelid and a.attnum = k.n order by k.o) as columns,
        c.confrelid::regclass::text as "refTable",
        array(select a.attname::text from unnest(c.confkey) with ordinality k(n, o)
          join pg_attribute a on a.attrelid = c.confrelid and a.attnum = k.n order by k.o) as "refColumns",
        pg_get_constraintdef(c.oid) as definition
      from pg_constraint c
      where c.connamespace = to_regnamespace(current_schema()) and c.contype in ('p', 'u', 'f')
      order by 1, 2`,
  );
  const indexes = await db.query<{ table: string; name: string; columns: string[]; definition: string }>(
    `select t.relname as table, i.relname as name,
        array(select pg_get_indexdef(x.indexrelid, k.o::int, true)
          from generate_series(1, x.indnkeyatts) k(o) order by k.o) as columns,
        pg_get_indexdef(x.indexrelid) as definition
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      where t.relnamespace = to_regnamespace(current_schema()) and x.indisunique
        and not exists (select 1 from pg_constraint c where c.conindid = x.indexrelid and c.contype in ('p', 'u'))
      order by 1, 2`,
  );
  return [
    ...constraints.rows.map((row) => ({
      table: row.table,
      name: row.name,
      kind: row.kind,
      columns: row.columns,
      ...(row.kind === 'f' ? { references: { table: row.refTable!, columns: row.refColumns ?? [] } } : {}),
      definition: row.definition,
    })),
    ...indexes.rows.map((row) => ({
      table: row.table,
      name: row.name,
      kind: 'i' as const,
      columns: row.columns,
      definition: row.definition,
    })),
  ];
}

/** Every index, by name, with its definition (schema-qualified names stripped). */
export async function indexesOf(db: Querier): Promise<IndexInfo[]> {
  const rows = await db.query<IndexInfo>(
    `select t.relname as table, i.relname as name, x.indisunique as unique,
        replace(pg_get_indexdef(x.indexrelid), quote_ident(current_schema()) || '.', '') as definition
      from pg_index x
      join pg_class i on i.oid = x.indexrelid
      join pg_class t on t.oid = x.indrelid
      where t.relnamespace = to_regnamespace(current_schema())
      order by 1, 2`,
  );
  return rows.rows;
}

/** The names of every constraint and index of the schema: what routes and the revert find objects by. */
export async function objectNamesOf(db: Querier): Promise<string[]> {
  const rows = await db.query<{ name: string }>(
    `select conname as name from pg_constraint where connamespace = to_regnamespace(current_schema())
      union
     select i.relname from pg_index x join pg_class i on i.oid = x.indexrelid
      where i.relnamespace = to_regnamespace(current_schema())
      order by 1`,
  );
  return rows.rows.map((row) => row.name);
}

/** What `0021` defaults every `tenant_id` to, and what its policy compares with, as `pg_get_expr` prints them. */
export const SETTING_EXPRESSION = "(NULLIF(current_setting('wirebench.tenant_id'::text, true), ''::text))::uuid";
export const POLICY_EXPRESSION = `(tenant_id = ${SETTING_EXPRESSION})`;

export type RowSecurityInfo = {
  readonly table: string;
  readonly enabled: boolean;
  readonly forced: boolean;
};

/** Each ordinary table's row-level security switches. */
export async function rowSecurityOf(db: Querier): Promise<RowSecurityInfo[]> {
  const rows = await db.query<RowSecurityInfo>(
    `select relname as table, relrowsecurity as enabled, relforcerowsecurity as forced from pg_class
      where relnamespace = to_regnamespace(current_schema()) and relkind = 'r' order by 1`,
  );
  return rows.rows;
}

export type PolicyInfo = {
  readonly table: string;
  readonly name: string;
  readonly permissive: boolean;
  readonly command: string;
  /** `{0}` is public. */
  readonly roles: string;
  readonly using: string | null;
  readonly check: string | null;
};

/** Every policy of the schema's tables. */
export async function policiesOf(db: Querier): Promise<PolicyInfo[]> {
  const rows = await db.query<PolicyInfo>(
    `select c.relname as table, p.polname as name, p.polpermissive as permissive, p.polcmd::text as command,
        p.polroles::text as roles, pg_get_expr(p.polqual, p.polrelid) as using,
        pg_get_expr(p.polwithcheck, p.polrelid) as check
      from pg_policy p join pg_class c on c.oid = p.polrelid
      where c.relnamespace = to_regnamespace(current_schema())
      order by 1, 2`,
  );
  return rows.rows;
}

/** The first migration the data-migration lint reads: `0021` ships `for_each_tenant`, so every later one. */
export const FIRST_LINTED_MIGRATION = 22;

/**
 * The lint of spec §19.4: from `0022` on, a migration whose SQL inserts, updates or deletes rows of a scoped table
 * must run it per tenant (`for_each_tenant(`) or bracket it with `no force row level security` and `force row level
 * security`. Without either, under the forced policy, it touches no row and still succeeds on a non-superuser
 * owner. Comments are skipped; a write inside a `do` block or a string still counts, so the check errs on the
 * strict side.
 * Returns the versions that break it.
 */
export function unscopedDataMigrations(
  migrations: readonly { readonly version: number; readonly sql: string }[],
): number[] {
  const writes = new RegExp(
    `\\b(?:insert\\s+into|update|delete\\s+from)\\s+(?:only\\s+)?(?:"?\\w+"?\\.)?"?(?:${SCOPED_TABLES.join('|')})"?(?![\\w"])`,
    'i',
  );
  const uncommented = (sql: string) => sql.replace(/--[^\n]*|\/\*[\s\S]*?\*\//g, ' ');
  return migrations
    .filter((migration) => migration.version >= FIRST_LINTED_MIGRATION)
    .filter((migration) => {
      const sql = uncommented(migration.sql);
      if (!writes.test(sql)) return false;
      const each = /\bfor_each_tenant\s*\(/i.test(sql);
      // Both halves: `no force …`, and a `force …` that is not part of one.
      const unforced = /\bno\s+force\s+row\s+level\s+security\b/i.test(sql);
      const forced = /\bforce\s+row\s+level\s+security\b/i.test(sql.replace(/\bno\s+force\b/gi, 'no_force'));
      return !each && !(unforced && forced);
    })
    .map((migration) => migration.version);
}
