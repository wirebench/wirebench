/**
 * What the app role holds in the server's schema (hosted edition spec §19.4), as SQL statements: the one
 * list of grants. The integration-test helper applies it after migrating each test schema as the owner;
 * `ensureAppRole` and `admin tenancy role [--print-sql]` (slice 4, Task 2) apply or print the same list.
 *
 * The app role owns nothing, so row-level security applies to it whether forced or not. It gets:
 * - `usage` on the schema, and no `create`;
 * - `select, insert, update, delete` on every table, and by default on every table the owner creates later;
 * - `select` only on the tables in `READ_ONLY_TABLES`.
 *
 * Every statement is idempotent, and the owner (or a superuser) runs them after the migrations. A table
 * named in `READ_ONLY_TABLES` that a schema does not have yet is skipped, so the list also fits a schema
 * migrated only part of the way, as some suites do.
 */

/**
 * Tables the app role reads and never writes. Today's server only reads `server_identity` (0013 mints its
 * row); Task 2 adds `update (tenancy_step)` on it once 0020 adds that column.
 */
export const READ_ONLY_TABLES: readonly string[] = ['schema_migrations', 'server_identity'];

export interface AppRoleNames {
  /** The schema the server's tables live in. */
  readonly schema: string;
  /** The role that owns the schema and its tables, and runs the migrations. */
  readonly owner: string;
  /** The role every query runs as. */
  readonly app: string;
}

/** A quoted SQL identifier, like `format('%I')` but always quoted. */
export function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A quoted SQL string literal (standard_conforming_strings, the default since PostgreSQL 9.1). */
export function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function appRoleGrants(names: AppRoleNames): readonly string[] {
  const schema = quoteIdent(names.schema);
  const owner = quoteIdent(names.owner);
  const app = quoteIdent(names.app);
  const readOnly = READ_ONLY_TABLES.map(quoteLiteral).join(', ');
  return [
    `grant usage on schema ${schema} to ${app}`,
    `grant select, insert, update, delete on all tables in schema ${schema} to ${app}`,
    `alter default privileges for role ${owner} in schema ${schema} grant select, insert, update, delete on tables to ${app}`,
    // A dollar-quoted block, so the list runs as plain statements and prints as one for --print-sql.
    `do $grants$
declare
  t text;
begin
  foreach t in array array[${readOnly}]::text[] loop
    if to_regclass(format('%I.%I', ${quoteLiteral(names.schema)}, t)) is not null then
      execute format('revoke insert, update, delete, truncate on %I.%I from %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
    end if;
  end loop;
end
$grants$`,
  ];
}
