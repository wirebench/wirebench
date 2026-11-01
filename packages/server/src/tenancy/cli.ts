/**
 * `wirebench-server admin tenancy check` and `admin tenancy status` (hosted edition spec §19.10, §19.11) are at the
 * end of this file.
 *
 * `wirebench-server admin tenancy role [--print-sql]` (hosted edition spec §19.4): the operator's switch to an
 * app role outside compose. It connects as the owner (`WIREBENCH_SERVER_MIGRATION_DATABASE_URL`) and runs what
 * `serve` runs at every start with two URLs: create the app role of `WIREBENCH_SERVER_DATABASE_URL` when it is
 * missing, then grant it its privileges. `--print-sql` only reads, and prints the statements for a role that
 * may create roles to apply.
 */
import { lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, forgetDatabaseUrls, loadConfig, migrationUrlOf, type ServerConfig } from '../config.js';
import { ADMIN_APPLICATION_NAME, createDatabase } from '../db/pool.js';
import type { Querier } from '../db/querier.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { appRoleReport, bypassReasons, MIN_POSTGRES_VERSION_NUM } from './checks.js';
import { CONSERVATIVE_RATE, estimateSeconds, MEASURED_RATE, passesOf, type TableSize } from './estimate.js';
import { KNOWN_ROOT_ENTRIES, MOVED_DIRS, OLD_TMP_DIR, readTenancyStep } from './file-step.js';
import { dataKeyState, environmentKeyRoot, type DataKeyState } from './keys.js';
import { appRolePlan, ensureAppRole, roleMode } from './roles.js';

type TenancyRoleCommand = Extract<ServerCommand, { command: 'admin-tenancy-role' }>;

const NEEDS_TWO_ROLES =
  'admin tenancy role needs two roles: WIREBENCH_SERVER_MIGRATION_DATABASE_URL set to the owner of the schema, and WIREBENCH_SERVER_DATABASE_URL to the app role';

/** The loaded configuration, or the exit code after the problems are written. */
function configOf(io: ServerIo): ServerConfig | number {
  try {
    const config = loadConfig(io.env, packageVersion());
    forgetDatabaseUrls();
    return config;
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      return ExitCode.Config;
    }
    throw error;
  }
}

export async function runTenancyRole(command: TenancyRoleCommand, io: ServerIo): Promise<number> {
  const loaded = configOf(io);
  if (typeof loaded === 'number') return loaded;
  const config = loaded;
  // The same rule as `serve` and `migrate`, so the three never disagree about a configuration.
  let mode: 'one-role' | 'two-roles';
  try {
    mode = roleMode(config);
  } catch (error) {
    if (!(error instanceof WirebenchError)) throw error;
    io.stderr.write(`${error.code}: ${error.message}\n`);
    return ExitCode.Config;
  }
  if (mode === 'one-role' || config.migrationDatabaseUrl === undefined) {
    io.stderr.write(`${NEEDS_TWO_ROLES}\n`);
    return ExitCode.Config;
  }
  const owner = createDatabase(config.migrationDatabaseUrl, { applicationName: ADMIN_APPLICATION_NAME });
  try {
    if (command.printSql) {
      // Read-only: the plan comes from the catalog, and nothing is run.
      // Who may run what: `create role` needs CREATEROLE, the grants and default privileges need the owner.
      // The verifier in `create role` is not the password, but it allows guessing at it offline.
      const plan = await appRolePlan(owner, config.databaseUrl);
      const [first, ...rest] = plan.statements;
      if (!plan.exists) {
        io.stdout.write('-- Secret: the next statement holds the app role password as a SCRAM-SHA-256 verifier.\n');
        io.stdout.write('-- As a role that may create roles (CREATEROLE):\n');
        io.stdout.write(`${first!};\n`);
      }
      io.stdout.write(`-- As the owner, ${plan.owner}:\n`);
      for (const statement of plan.exists ? plan.statements : rest) io.stdout.write(`${statement};\n`);
      return ExitCode.Ok;
    }
    const plan = await ensureAppRole(owner, config.databaseUrl);
    io.stdout.write(
      `app role ${plan.role}: ${plan.exists ? 'exists' : 'created'}; privileges granted on schema ${plan.schema}\n`,
    );
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof WirebenchError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return 1;
    }
    throw error;
  } finally {
    await owner.close();
  }
}

/** Spec §19.4: `pg_dump` as the app role, or as an owner that is no superuser, cannot back up a scoped table. */
export const BACKUP_ADVICE =
  'back up the database as a superuser or as a role of its own with BYPASSRLS: as the app role, or as an owner ' +
  'that is no superuser, pg_dump refuses the tables under row-level security (with --enable-row-security it ' +
  'dumps them empty)';

const MIB = 1024 * 1024;
const mib = (bytes: number): string => `${(bytes / MIB).toFixed(1)} MiB`;
const seconds = (value: number): string => (value < 1 ? 'under a second' : `about ${String(Math.ceil(value))} s`);

/** Each table of the server's schema but the migrations ledger, with its estimated rows and its sizes. */
async function tableSizes(db: Querier): Promise<(TableSize & { readonly totalBytes: number })[]> {
  // reltuples is right under any role, before and after the upgrade; -1 is "never analysed".
  const rows = await db.query<{ table: string; rows: number; heapBytes: string; totalBytes: string }>(
    `select c.relname as table, greatest(c.reltuples, 0)::float8 as rows,
        pg_relation_size(c.oid)::text as "heapBytes", pg_total_relation_size(c.oid)::text as "totalBytes"
      from pg_class c
      where c.relnamespace = to_regnamespace(current_schema()) and c.relkind = 'r' and c.relname <> 'schema_migrations'
      order by c.relname`,
  );
  return rows.rows.map((r) => ({
    table: r.table,
    rows: Math.round(r.rows),
    heapBytes: Number(r.heapBytes),
    totalBytes: Number(r.totalBytes),
  }));
}

/** What the data directory holds, read only: the move's sources, whether a rename can do it, and anything else. */
async function dataDirReport(dataDir: string): Promise<string[]> {
  const lines = [`data directory: ${dataDir}`];
  let root;
  try {
    root = await lstat(dataDir);
  } catch (error) {
    lines.push(`  cannot read it: ${(error as Error).message}`);
    return lines;
  }
  const names = await readdir(dataDir);
  // The move is a rename, never a copy: each source must be on the filesystem tenants/ will be made on.
  const elsewhere: string[] = [];
  // The move refuses a link (tenancy-move-link): the new layout does not follow them.
  const links: string[] = [];
  for (const name of MOVED_DIRS) {
    if (!names.includes(name)) continue;
    const info = await lstat(join(dataDir, name));
    if (info.isSymbolicLink()) links.push(`${name}/`);
    else if (info.dev !== root.dev) elsewhere.push(`${name}/`);
    const count = (await readdir(join(dataDir, name))).length;
    lines.push(`  ${name}/: ${String(count)} ${name === 'repos' ? 'repositories' : 'users'}, to be moved`);
  }
  if (names.includes(OLD_TMP_DIR)) {
    const tmp = await readdir(join(dataDir, OLD_TMP_DIR));
    const kept = tmp.filter((name) => name.startsWith('removed-')).length;
    lines.push(
      `  ${OLD_TMP_DIR}/: ${String(kept)} deleted workspaces kept, ${String(tmp.length - kept)} scratch entries deleted`,
    );
  }
  lines.push(
    elsewhere.length === 0
      ? '  same filesystem: yes'
      : `  same filesystem: no, ${elsewhere.join(' and ')} on another filesystem; the move is a rename, so put them on the data directory's filesystem first`,
  );
  lines.push(
    links.length === 0
      ? '  links: none'
      : `  links: ${links.join(' and ')} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}, which the move refuses; replace each with the directory itself, or mount the volume at its new place`,
  );
  const unknown = names.filter((name) => !KNOWN_ROOT_ENTRIES.includes(name));
  lines.push(`  unknown paths: ${unknown.length === 0 ? 'none' : unknown.join(', ')}`);
  return lines;
}

/**
 * `admin tenancy check` (spec §19.10): run from the new image against the old database before the upgrade, and
 * read only, on the database (one read-only transaction) and on the data directory (stat and list).
 */
export async function runTenancyCheck(io: ServerIo): Promise<number> {
  const loaded = configOf(io);
  if (typeof loaded === 'number') return loaded;
  const config = loaded;
  const out = (line: string): void => {
    io.stdout.write(`${line}\n`);
  };
  const db = createDatabase(migrationUrlOf(config), { applicationName: ADMIN_APPLICATION_NAME, max: 1 });
  try {
    const facts = await db.transaction(async (tx) => {
      await tx.query('set transaction read only');
      const version = await tx.query<{ text: string; num: string }>(
        "select current_setting('server_version') as text, current_setting('server_version_num') as num",
      );
      const ledger = await tx.query<{ version: number | null }>(
        'select max(version)::int as version from schema_migrations',
      );
      return { version: version.rows[0]!, schema: ledger.rows[0]?.version ?? null, tables: await tableSizes(tx) };
    });
    const versionOk = Number(facts.version.num) >= MIN_POSTGRES_VERSION_NUM;
    out(`PostgreSQL: ${facts.version.text}${versionOk ? '' : ' (too old: the upgrade needs PostgreSQL 15 or later)'}`);
    out(`schema version: ${facts.schema === null ? 'none' : String(facts.schema)}`);
    out(`app role: ${await appRoleLine(config)}`);
    out(`backups: ${BACKUP_ADVICE}`);
    for (const line of await dataDirReport(config.dataDir)) out(line);
    out('tables (rows, heap, total, passes):');
    for (const t of facts.tables) {
      out(
        `  ${t.table}: ${String(t.rows)} rows, ${mib(t.heapBytes)}, ${mib(t.totalBytes)}, ${String(passesOf(t.table))}`,
      );
    }
    const low = estimateSeconds(facts.tables, MEASURED_RATE);
    const high = estimateSeconds(facts.tables, CONSERVATIVE_RATE);
    out(
      `estimated downtime for the migration: ${seconds(low)} at the measured rate, ${seconds(high)} at the ` +
        'conservative one (0.5 million rows and 200 MB a second)',
    );
    return versionOk ? ExitCode.Ok : ExitCode.Config;
  } catch (error) {
    // The database could not be read: exit 3, as every command that fails on the database does; 2 is configuration.
    if (error instanceof WirebenchError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.Migration;
    }
    io.stderr.write(`admin tenancy check failed: ${(error as Error).message}\n`);
    return ExitCode.Migration;
  } finally {
    await db.close();
  }
}

/** Whether the server's own role isolates (§19.4), read over its URL; never the URL itself. */
async function appRoleLine(config: ServerConfig): Promise<string> {
  const app = createDatabase(config.databaseUrl, { applicationName: ADMIN_APPLICATION_NAME, max: 1 });
  try {
    const report = await appRoleReport(app);
    const reasons = bypassReasons(report);
    return reasons.length === 0
      ? `${report.role} is under row-level security`
      : `${report.role} ${reasons.join(', ')}, so row-level security cannot be relied on for it`;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    return `cannot sign in${typeof code === 'string' ? ` (${code})` : ''}`;
  } finally {
    await app.close();
  }
}

/** The `data key:` line of `admin tenancy status`. */
export const DATA_KEY_TEXT: Readonly<Record<DataKeyState, string>> = {
  none: 'none',
  made: 'made (WIREBENCH_SERVER_SECRETS_KEY is not set, so it was not tried)',
  opens: 'made, and it opens under WIREBENCH_SERVER_SECRETS_KEY',
  refused:
    'made, but it does not open under WIREBENCH_SERVER_SECRETS_KEY: the key was changed. Restore the key it was made under; until then no browser host opens',
};

/** `admin tenancy status` (spec §19.11): where the upgrade stands. Never prints a slug. */
export async function runTenancyStatus(io: ServerIo): Promise<number> {
  const loaded = configOf(io);
  if (typeof loaded === 'number') return loaded;
  const db = createDatabase(migrationUrlOf(loaded), { applicationName: ADMIN_APPLICATION_NAME, max: 1 });
  try {
    const state = await readTenancyStep(db);
    if (state === undefined) {
      io.stdout.write('step: not started (migration 0020 is not applied)\n');
    } else {
      io.stdout.write(`step: ${state.step}\n`);
      io.stdout.write(`default tenant: ${state.defaultTenantId}\n`);
    }
    // Whether it exists and opens under the configured key, never the key or its wrap (Task 23 review I1, M6).
    const root = loaded.secretsKey !== undefined ? environmentKeyRoot(loaded.secretsKey) : undefined;
    const key: DataKeyState = state === undefined ? 'none' : await dataKeyState(db, state.defaultTenantId, root);
    io.stdout.write(`data key: ${DATA_KEY_TEXT[key]}\n`);
    // Plan Task 24: the re-wrap.
    io.stdout.write('re-wrap: not run\n');
    io.stdout.write(`backups: ${BACKUP_ADVICE}\n`);
    return ExitCode.Ok;
  } catch (error) {
    io.stderr.write(`admin tenancy status failed: ${(error as Error).message}\n`);
    return ExitCode.Migration;
  } finally {
    await db.close();
  }
}
