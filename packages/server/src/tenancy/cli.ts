/**
 * `wirebench-server admin tenancy check`, `admin tenancy status` and `admin tenancy revert` (hosted edition spec
 * §19.10, §19.11) are at the end of this file.
 *
 * `wirebench-server admin tenancy role [--print-sql]` (hosted edition spec §19.4): the operator's switch to an
 * app role outside compose. It connects as the owner (`WIREBENCH_SERVER_MIGRATION_DATABASE_URL`) and runs what
 * `serve` runs at every start with two URLs: create the app role of `WIREBENCH_SERVER_DATABASE_URL` when it is
 * missing, then grant it its privileges. `--print-sql` only reads, and prints the statements for a role that
 * may create roles to apply. In hosted mode it does the same for the control role of
 * `WIREBENCH_SERVER_CONTROL_DATABASE_URL` (spec §22.2), whose `create role` only a superuser may run.
 */
import { access, lstat, readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { ServerCommand } from '../args.js';
import { ConfigError, forgetDatabaseUrls, loadConfig, migrationUrlOf, type ServerConfig } from '../config.js';
import { ADMIN_APPLICATION_NAME, createDatabase } from '../db/pool.js';
import type { Querier } from '../db/querier.js';
import { ExitCode, packageVersion, type ServerIo } from '../io.js';
import { appRoleReport, bypassReasons, MIN_POSTGRES_VERSION_NUM } from './checks.js';
import { CONSERVATIVE_RATE, estimateSeconds, MEASURED_RATE, passesOf, type TableSize } from './estimate.js';
import {
  blobs,
  KNOWN_ROOT_ENTRIES,
  MOVED_DIRS,
  OLD_TMP_DIR,
  readTenancyStep,
  type TenancyStepState,
} from './file-step.js';
import { dataKeyState, environmentKeyRoot, storedDataKey, type DataKeyState } from './keys.js';
import { tenantRootById } from './paths.js';
import { revertTenancy, type RevertOptions } from './revert.js';
import { rewrap } from './rewrap.js';
import { appRolePlan, controlRolePlan, ensureAppRole, ensureControlRole, roleMode, roleNameOf } from './roles.js';

type TenancyRoleCommand = Extract<ServerCommand, { command: 'admin-tenancy-role' }>;
type TenancyRevertCommand = Extract<ServerCommand, { command: 'admin-tenancy-revert' }>;

/** What a test may change of the revert: its wait, the sessions it reads, and where it stops. */
export type RevertSeams = Pick<RevertOptions, 'waitMs' | 'sleep' | 'serverSessions' | 'checkpoint' | 'fs'>;

const NEEDS_TWO_ROLES =
  'admin tenancy role needs two roles: WIREBENCH_SERVER_MIGRATION_DATABASE_URL set to the owner of the schema, and WIREBENCH_SERVER_DATABASE_URL to the app role';

/** What `admin tenancy revert` says it did. */
const REVERT_OUTCOMES = {
  nothing: 'nothing to revert: the database is at schema version 19 or before',
  'not-reverting': 'nothing to abort: no revert is under way',
  aborted:
    'aborted: the next server start (or wirebench-server migrate) runs the upgrade’s steps again and re-seals ' +
    'under the data key',
  reverted:
    'reverted: the previous version of the server can now start on this database and data directory. It reads ' +
    'WIREBENCH_SERVER_DATABASE_URL only: set it to the owner’s direct URL, as before the upgrade. Start it by its ' +
    'own image tag, never latest, or this version starts and upgrades again',
} as const;

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
  return runTenancyRoleWith(command, io, loaded);
}

/** `admin tenancy role` on a loaded configuration: a hosted one, until `loadConfig` accepts it, only from a test. */
export async function runTenancyRoleWith(
  command: TenancyRoleCommand,
  io: ServerIo,
  config: ServerConfig,
): Promise<number> {
  // Hosted mode always has the control URL (`controlPlaneProblems`); a test-built config without it has no control
  // role to make.
  const controlUrl = config.mode === 'hosted' ? config.controlDatabaseUrl : undefined;
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
      if (controlUrl !== undefined) {
        const control = await controlRolePlan(owner, controlUrl, config.databaseUrl);
        const [create, ...grants] = control.statements;
        if (!control.exists) {
          io.stdout.write(
            '-- Secret: the next statement holds the control role password as a SCRAM-SHA-256 verifier.\n',
          );
          io.stdout.write('-- As a superuser (only one may create a BYPASSRLS role):\n');
          io.stdout.write(`${create!};\n`);
        }
        io.stdout.write(`-- As the owner, ${control.owner}:\n`);
        for (const statement of control.exists ? control.statements : grants) io.stdout.write(`${statement};\n`);
      }
      return ExitCode.Ok;
    }
    const plan = await ensureAppRole(owner, config.databaseUrl);
    io.stdout.write(
      `app role ${plan.role}: ${plan.exists ? 'exists' : 'created'}; privileges granted on schema ${plan.schema}\n`,
    );
    if (controlUrl !== undefined) {
      const control = await ensureControlRole(owner, controlUrl, config.databaseUrl);
      io.stdout.write(
        `control role ${control.role}: ${control.exists ? 'exists' : 'created'}; privileges granted on schema ${control.schema}\n`,
      );
    }
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
    out(`app role: ${await appRoleLine(config, db)}`);
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

/**
 * Whether the server's own role isolates (§19.4), read over its URL; never the URL itself. When it cannot sign in,
 * the owner's connection says whether the role exists yet: before an upgrade's first start it does not, and that
 * start creates it.
 */
async function appRoleLine(config: ServerConfig, owner: Querier): Promise<string> {
  const app = createDatabase(config.databaseUrl, { applicationName: ADMIN_APPLICATION_NAME, max: 1 });
  try {
    const report = await appRoleReport(app);
    const reasons = bypassReasons(report);
    return reasons.length === 0
      ? `${report.role} is under row-level security`
      : `${report.role} ${reasons.join(', ')}, so row-level security cannot be relied on for it`;
  } catch (error) {
    const code = (error as { code?: unknown }).code;
    const role = roleNameOf(config.databaseUrl);
    if (role !== undefined && !(await roleExists(owner, role))) {
      return `${role} does not exist yet: the server creates it at its first start`;
    }
    return `cannot sign in${typeof code === 'string' ? ` (${code})` : ''}`;
  } finally {
    await app.close();
  }
}

/** Whether a role of that name exists in the cluster; when even that cannot be read, it is taken to exist. */
async function roleExists(owner: Querier, role: string): Promise<boolean> {
  try {
    const found = await owner.query('select 1 from pg_roles where rolname = $1', [role]);
    return found.rows.length > 0;
  } catch {
    return true;
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

/**
 * The `re-wrap:` line: counts from a dry run over the default tenant's checkouts, read only, once the key opens.
 * Counts alone: never a file name, a key or a value.
 */
async function rewrapStatus(
  db: Querier,
  config: ServerConfig,
  state: TenancyStepState | undefined,
  key: DataKeyState,
): Promise<string> {
  if (state === undefined || state.step === 'files') return 'not run';
  if (config.secretsKey === undefined) return 'waits for WIREBENCH_SERVER_SECRETS_KEY';
  if (key !== 'opens') return 'not run';
  // Read only: never makes a key, even if the row was cleared since `dataKeyState` read it (Task 24 review m8).
  const dataKey = await storedDataKey(db, state.defaultTenantId, environmentKeyRoot(config.secretsKey));
  if (dataKey === undefined) return 'not run';
  const checkouts = join(tenantRootById(config.dataDir, state.defaultTenantId), 'checkouts');
  // Lenient, as the check at `done` is: a file it cannot read is counted by its code, never named (Part D review P1).
  const counts = await rewrap(checkouts, { root: config.secretsKey, dataKey }, 'forward', {
    dryRun: true,
    lenient: true,
  });
  const old =
    counts.resealed > 0 && state.step === 'done'
      ? ' (the next start, or `wirebench-server migrate`, re-seals them)'
      : '';
  return (
    `${blobs(counts.already)} under the data key, ${String(counts.resealed)} still under the old key${old}, ` +
    `${String(counts.unopened)} open under neither (left as they were), ` +
    `${String(counts.skipped)} links or other entries skipped` +
    (counts.unreadable > 0 ? `, ${String(counts.unreadable)} could not be read (${counts.codes.join(', ')})` : '')
  );
}

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
    io.stdout.write(`re-wrap: ${await rewrapStatus(db, loaded, state, key)}\n`);
    io.stdout.write(`backups: ${BACKUP_ADVICE}\n`);
    return ExitCode.Ok;
  } catch (error) {
    // A coded refusal keeps its message; any other error says its code alone, since Node's message can name a path
    // under tenants/<id>/checkouts/<user> (Part D review m4).
    const why =
      error instanceof WirebenchError
        ? `${error.code}: ${error.message}`
        : ((error as NodeJS.ErrnoException | null)?.code ?? 'an unexpected error');
    io.stderr.write(`admin tenancy status failed: ${why}\n`);
    return ExitCode.Migration;
  } finally {
    await db.close();
  }
}

/**
 * `admin tenancy revert [--accept-unopened | --abort]` (spec §19.10): as the owner, over the migration URL, with every
 * server stopped. A refusal exits 2 and leaves the step where it was; a run stopped part way resumes at the next.
 */
export async function runTenancyRevert(
  command: TenancyRevertCommand,
  io: ServerIo,
  seams: RevertSeams = {},
): Promise<number> {
  const loaded = configOf(io);
  if (typeof loaded === 'number') return loaded;
  const config = loaded;
  // The files move back with the rows: a revert run where the data directory is not mounted would leave them behind.
  const mounted = await access(config.dataDir).then(
    () => true,
    () => false,
  );
  if (!mounted) {
    io.stderr.write(
      `tenancy-revert-no-data-dir: the data directory ${config.dataDir} is not here; run the revert where the ` +
        "server's data directory is mounted. Nothing was changed\n",
    );
    return ExitCode.Config;
  }
  // The servers' pools connect over the app URL: one that names its sessions hides them from the revert's check,
  // as the migration URL's own would (which `revertTenancy` reads on its session).
  if (/application_name/i.test(config.databaseUrl)) {
    io.stderr.write(
      'tenancy-revert-application-name: WIREBENCH_SERVER_DATABASE_URL sets application_name, so the revert cannot ' +
        "tell the servers' connections apart in pg_stat_activity: remove it from the servers' URLs and from this " +
        'one, and run the revert again. Nothing was changed\n',
    );
    return ExitCode.Config;
  }
  try {
    const result = await revertTenancy({
      ...seams,
      url: migrationUrlOf(config),
      dataDir: config.dataDir,
      ...(config.secretsKey !== undefined ? { root: config.secretsKey } : {}),
      acceptUnopened: command.acceptUnopened,
      abort: command.abort,
      mode: config.mode,
      report: (line) => io.stdout.write(`${line}\n`),
    });
    io.stdout.write(`${REVERT_OUTCOMES[result.outcome]}\n`);
    return ExitCode.Ok;
  } catch (error) {
    if (error instanceof WirebenchError) {
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.Config;
    }
    // The errno or database code only: a message can name a path under tenants/<id>/checkouts/<user>.
    const code = (error as { code?: unknown } | null)?.code;
    io.stderr.write(
      `admin tenancy revert failed (${typeof code === 'string' ? code : 'an unexpected error'}); run it again to resume\n`,
    );
    return ExitCode.Migration;
  }
}
