/**
 * What the app role holds in the server's schema (hosted edition spec §19.4), as SQL statements: the one
 * list of grants. `ensureAppRole` runs it as the owner, in one transaction, at every start with two URLs and
 * in the test helper; `admin tenancy role --print-sql` prints it.
 *
 * The app role owns nothing, so row-level security applies to it whether forced or not. It gets:
 * - `usage` on the schema, and no `create`;
 * - `select` only on the tables in `READ_ONLY_TABLES`;
 * - `select, insert, update, delete` on every other table, and by default on every table the owner creates
 *   later.
 *
 * Every statement is idempotent, and the owner (or a superuser) runs them after the migrations. The tables
 * are granted one by one in a single block, so even applied statement by statement (`psql` in autocommit)
 * the app role never holds a write on a read-only table, not even for a moment.
 */
import { WirebenchError } from '@wirebench/engine';

/**
 * Tables the app role reads and never writes. Today's server only reads `server_identity` (0013 mints its
 * row); slice 4's Task 4 adds `update (tenancy_step)` on it once 0020 adds that column.
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
function quoteIdent(name: string): string {
  return `"${name.replaceAll('"', '""')}"`;
}

/** A quoted SQL string literal (standard_conforming_strings, the default since PostgreSQL 9.1). */
function quoteLiteral(value: string): string {
  return `'${value.replaceAll("'", "''")}'`;
}

export function appRoleGrants(names: AppRoleNames): readonly string[] {
  // The names go into a dollar-quoted block, which a `$` could end early. No name the server is given
  // has one, so one is refused rather than quoted.
  for (const [what, name] of Object.entries(names) as [string, string][]) {
    if (name.includes('$')) {
      throw new WirebenchError('tenancy-role-name-invalid', `the ${what} name may not contain "$"`);
    }
  }
  const schema = quoteIdent(names.schema);
  const owner = quoteIdent(names.owner);
  const app = quoteIdent(names.app);
  const readOnly = READ_ONLY_TABLES.map(quoteLiteral).join(', ');
  return [
    `grant usage on schema ${schema} to ${app}`,
    // Ordinary, partitioned and foreign tables, views and materialised views: what `on all tables` covers.
    `do $grants$
declare
  t text;
begin
  for t in
    select c.relname from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${quoteLiteral(names.schema)} and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    if t = any (array[${readOnly}]::text[]) then
      execute format('grant select on %I.%I to %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
      execute format('revoke insert, update, delete, truncate on %I.%I from %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
    else
      execute format('grant select, insert, update, delete on %I.%I to %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
    end if;
  end loop;
end
$grants$`,
    `alter default privileges for role ${owner} in schema ${schema} grant select, insert, update, delete on tables to ${app}`,
  ];
}
