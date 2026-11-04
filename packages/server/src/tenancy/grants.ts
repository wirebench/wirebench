/**
 * What the app role holds in the server's schema (hosted edition spec §19.4), as SQL statements: the one
 * list of grants. `ensureAppRole` runs it as the owner, in one transaction, at every start with two URLs and
 * in the test helper; `admin tenancy role --print-sql` prints it.
 *
 * The app role owns nothing, so row-level security applies to it whether forced or not. It gets:
 * - `usage` on the schema, and no `create`;
 * - `select` only on the tables in `READ_ONLY_TABLES`, plus `update (tenancy_step)` on `server_identity`;
 * - nothing on the tables in `CONTROL_ONLY_TABLES`, which only the control role touches (spec §22.2);
 * - `select, insert, update, delete` on every other table, and by default on every table the owner creates
 *   later.
 *
 * Every statement is idempotent, and the owner (or a superuser) runs them after the migrations. The tables
 * are granted one by one in a single block, so even applied statement by statement (`psql` in autocommit)
 * the app role never holds a write on a read-only table, not even for a moment.
 */
import { WirebenchError } from '@wirebench/engine';

/**
 * Tables the app role reads and never writes, but for one column: on `server_identity` (0013 mints its row)
 * it may update `tenancy_step`, which 0020 adds and the file step writes.
 */
export const READ_ONLY_TABLES: readonly string[] = ['schema_migrations', 'server_identity'];

/**
 * The control plane's own unscoped tables (migration `0023`, spec §22.3): only the control role touches them, so the
 * app role holds nothing on them, not even what the owner's default privileges gave it when `0023` created them.
 */
export const CONTROL_ONLY_TABLES: readonly string[] = [
  'tenant_slugs_retired',
  'signups',
  'billing_events',
  'tenant_deletions',
];

/**
 * The tables the control role reads and writes (spec §22.2): `tenants`, and the control plane's own tables. The one
 * list: `controlRoleGrants` and its test read it.
 */
export const CONTROL_TABLES: readonly string[] = ['tenants', ...CONTROL_ONLY_TABLES];

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

/** The names go into a dollar-quoted block, which a `$` could end early. No name the server is given has one. */
function refuseDollar(names: Readonly<Record<string, string>>): void {
  for (const [what, name] of Object.entries(names)) {
    if (name.includes('$')) {
      throw new WirebenchError('tenancy-role-name-invalid', `the ${what} name may not contain "$"`);
    }
  }
}

export function appRoleGrants(names: AppRoleNames): readonly string[] {
  refuseDollar({ ...names });
  const schema = quoteIdent(names.schema);
  const owner = quoteIdent(names.owner);
  const app = quoteIdent(names.app);
  const readOnly = READ_ONLY_TABLES.map(quoteLiteral).join(', ');
  const controlOnly = CONTROL_ONLY_TABLES.map(quoteLiteral).join(', ');
  return [
    `grant usage on schema ${schema} to ${app}`,
    // Ordinary, partitioned and foreign tables, views and materialised views: what `on all tables` covers.
    `do $grants$
declare
  t text;
  rel oid;
begin
  for t, rel in
    select c.relname, c.oid from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${quoteLiteral(names.schema)} and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    if t = any (array[${readOnly}]::text[]) then
      execute format('grant select on %I.%I to %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
      execute format('revoke insert, update, delete, truncate on %I.%I from %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
      -- The one column the server writes, once 0020 has added it (file step, spec §19.10).
      if t = 'server_identity' and exists (
        select 1 from pg_attribute a
        where a.attrelid = rel and a.attname = 'tenancy_step' and not a.attisdropped
      ) then
        execute format('grant update (tenancy_step) on %I.%I to %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
      end if;
    elsif t = any (array[${controlOnly}]::text[]) then
      -- The owner's default privileges granted these at create time: taken back, all of them.
      execute format('revoke all on %I.%I from %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
    else
      execute format('grant select, insert, update, delete on %I.%I to %I', ${quoteLiteral(names.schema)}, t, ${quoteLiteral(names.app)});
    end if;
  end loop;
end
$grants$`,
    `alter default privileges for role ${owner} in schema ${schema} grant select, insert, update, delete on tables to ${app}`,
  ];
}

export interface ControlRoleNames {
  /** The schema the server's tables live in. */
  readonly schema: string;
  /** The control role (spec §22.2). */
  readonly control: string;
}

/**
 * What the control role holds (spec §22.2), as SQL statements the owner runs: `usage` on the schema; `select, insert,
 * update, delete` on {@link CONTROL_TABLES}; `select` on every scoped table, for the deletion check (§22.11), and no
 * write on one, since every per-tenant write runs in that tenant's unit on the app role; nothing on any other table.
 * The scoped tables are read from the catalog as the app role's grants are, by the policy `tenant_scope()` turned on
 * (`relrowsecurity`), so a table a later migration scopes is covered at the next run. No default privileges: a table
 * the owner creates later gets nothing until this runs again, which `serve` does at every hosted start.
 */
export function controlRoleGrants(names: ControlRoleNames): readonly string[] {
  refuseDollar({ ...names });
  const schema = quoteLiteral(names.schema);
  const control = quoteLiteral(names.control);
  const tables = CONTROL_TABLES.map(quoteLiteral).join(', ');
  return [
    `grant usage on schema ${quoteIdent(names.schema)} to ${quoteIdent(names.control)}`,
    `do $grants$
declare
  t text;
  scoped boolean;
begin
  for t, scoped in
    select c.relname, c.relrowsecurity from pg_class c
    join pg_namespace n on n.oid = c.relnamespace
    where n.nspname = ${schema} and c.relkind in ('r', 'p', 'v', 'm', 'f')
  loop
    if t = any (array[${tables}]::text[]) then
      execute format('grant select, insert, update, delete on %I.%I to %I', ${schema}, t, ${control});
      execute format('revoke truncate, references, trigger on %I.%I from %I', ${schema}, t, ${control});
    elsif scoped then
      execute format('grant select on %I.%I to %I', ${schema}, t, ${control});
      execute format('revoke insert, update, delete, truncate, references, trigger on %I.%I from %I', ${schema}, t, ${control});
    else
      execute format('revoke all on %I.%I from %I', ${schema}, t, ${control});
    end if;
  end loop;
end
$grants$`,
  ];
}
