/**
 * `wirebench-server admin tenancy revert` (hosted edition spec §19.10, plan Task 28): the way back from slice 4 to
 * the `0019` schema and the data directory's old layout, for a self-hosted installation of one tenant.
 *
 * **When it refuses**, before it changes anything:
 * - the server is in hosted mode (`tenancy-revert-hosted`), or the URL names its sessions itself, which hides the
 *   servers' sessions from the check below (`tenancy-revert-application-name`);
 * - the database has more than one tenant (`tenancy-revert-tenants`), or a migration newer than `0021` has run
 *   (`tenancy-revert-too-new`), or it is not at `0021` at all (`tenancy-revert-version`). Slice 5's `0022` is the
 *   first such migration: a server that has run it is past the way back (spec §19.10, "the command goes away with
 *   the first release that adds migration `0022`"), so the refusal names it;
 * - a server holds the server-running lock: the exclusive `pg_try_advisory_lock` fails while any server holds it
 *   shared (`tenancy-revert-server-running`). It is taken on the migration URL, a direct connection, as every server
 *   holds its share there (owner ruling, 2026-10-30), and held until the revert ends;
 * - once it holds the lock, it waits {@link REVERT_WAIT_MS}: a server whose lock connection dropped silently goes on
 *   serving until its heartbeat sees the drop and its re-take gives up, at most {@link LOST_LOCK_STOP_MS}, then
 *   drains. A server session still in `pg_stat_activity` after that refuses too;
 * - the data directory is not the server's (`tenancy-data-dir-empty`, `tenancy-workspaces-missing`), a directory is
 *   in both its places (`tenancy-move-conflict`), a link or another filesystem is in the way (`tenancy-move-link`,
 *   `tenancy-move-cross-device`), a state file names the tenant's checkouts path (`tenancy-prefix-found`), or the
 *   tenant's directory holds something the move does not know (`tenancy-revert-unknown-files`);
 * - the data key cannot be opened (`tenancy-no-root`, `tenancy-data-key-refused`);
 * - `back`, run first as a dry run, would leave blobs as they are: ones that open under neither key, or links it
 *   does not follow (`tenancy-revert-unopened`), unless it is told to go on (`acceptUnopened`).
 *
 * **What it does**, through three steps of `server_identity.tenancy_step`, each persisted before it starts, so a kill
 * anywhere resumes, and a forward start-up or `migrate` in any of them refuses (`tenancy-reverting`):
 * 1. `reverting-keys`: `rewrap(…, 'back')`, strict, re-seals every blob of the users' checkouts under slice 2's
 *    per-user key, which the previous image reads. It tries the old key first, so a resumed run never seals twice.
 *    What it leaves as it is was refused in the pre-flight already; anything new since stops the revert here, where
 *    `abort` can still hand the installation back to the forward steps.
 * 2. `reverting-files`: the directories are renamed back to the data directory's root, and the tenant's scratch is
 *    deleted. Every rename is due or done by what is on disk.
 * 3. `reverting-rows`: `revert-0020-0021.sql`, in one transaction, which also deletes the step column.
 *
 * Every database statement runs on the one session that holds the lock, so a lock lost with its connection fails the
 * next statement rather than letting a server start under a revert, and stops the file work before its next part.
 * Nothing here names a tenant or a slug in what it prints: refusals name paths, with `tenants/<default tenant>/` in
 * place of the tenant's id.
 */
import { lstat, mkdir, readdir, readFile, rm, rmdir } from 'node:fs/promises';
import { join, relative, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { ServerMode } from '../config.js';
import { ADMIN_APPLICATION_NAME, APPLICATION_NAME, openSession, type Session } from '../db/pool.js';
import type { Querier } from '../db/querier.js';
import {
  conflict,
  databaseHasData,
  dataDirEmpty,
  FILE_STEP_CLASS,
  listed,
  MOVED_DIRS,
  OLD_TMP_DIR,
  prefixFiles,
  readTenancyStep,
  realFs,
  type StepFs,
  type TenancyStep,
} from './file-step.js';
import { environmentKeyRoot, storedDataKey } from './keys.js';
import { tenantRootById, tenantsDir } from './paths.js';
import { rewrap, type RewrapCounts } from './rewrap.js';
import { LOCK_SCHEMA_KEY, LOST_LOCK_STOP_MS, SERVER_DRAIN_MS, SERVER_RUNNING_CLASS } from './running-lock.js';
import { SET_TENANT } from './tenant-db.js';

/** What `reverting-rows` runs: read by this command, never by the migration runner (its name has no version). */
export const REVERT_SQL_FILE = fileURLToPath(new URL('../../migrations/tenancy/revert-0020-0021.sql', import.meta.url));

/** The last migration of slice 4: the revert undoes `0020` and `0021`, and refuses anything newer. */
export const LAST_TENANCY_MIGRATION = 21;
/** The schema version before slice 4, and after a revert. */
export const BEFORE_TENANCY = 19;

/** How long the revert waits, holding the lock, before it reads `pg_stat_activity`: 170 s, then the drain. */
export const REVERT_WAIT_MS = LOST_LOCK_STOP_MS + SERVER_DRAIN_MS;

/** The lock, and the session's pid, in the session's first query. */
const TAKE_EXCLUSIVE = `select pg_backend_pid() as pid, pg_try_advisory_lock($1, ${LOCK_SCHEMA_KEY}) as ok`;

/** A tenant's directory holds these, and only these. */
const TENANT_ENTRIES: readonly string[] = [...MOVED_DIRS, OLD_TMP_DIR];
const REMOVED = /^removed-/;

export type RevertStep = Extract<TenancyStep, `reverting-${string}`>;

/** One connection `pg_stat_activity` shows as a server's. */
export interface ServerSession {
  readonly pid: number;
  readonly name: string;
}

export interface RevertOptions {
  /** The migration URL: the owner, on a direct connection. */
  readonly url: string;
  readonly dataDir: string;
  /** `WIREBENCH_SERVER_SECRETS_KEY`: needed when the default tenant has a data key. */
  readonly root?: Buffer;
  /** Go on past blobs `back` cannot open and links it does not follow (`--accept-unopened`). */
  readonly acceptUnopened?: boolean;
  /** `--abort`: give a revert still at `reverting-keys` back to the forward steps. */
  readonly abort?: boolean;
  /** The configured mode: hosted refuses. */
  readonly mode?: ServerMode;
  /** What the revert says as it goes: counts and steps, never a value, a tenant or a user. */
  readonly report?: (line: string) => void;
  /** How long to wait with the lock held; {@link REVERT_WAIT_MS} by default. */
  readonly waitMs?: number;
  /** Test only: how the wait waits. */
  readonly sleep?: (ms: number) => Promise<void>;
  /** Test only: the server sessions still connected; {@link serverSessions} by default. */
  readonly serverSessions?: (db: Querier) => Promise<readonly ServerSession[]>;
  /** Test only: called after each part has happened, so a test can stop the revert there. */
  readonly checkpoint?: (part: string) => void;
  readonly fs?: StepFs;
}

export interface RevertResult {
  /**
   * `nothing` when the database is already before slice 4; with `abort`, `aborted`, or `not-reverting` when no revert
   * was under way.
   */
  readonly outcome: 'reverted' | 'nothing' | 'aborted' | 'not-reverting';
  /** The `back` re-wrap's counts, when it ran in this call. */
  readonly counts?: RewrapCounts;
}

const refusal = (code: string, message: string): WirebenchError => new WirebenchError(code, message);

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

/** Whether a directory itself (never through a link) is at `path`. */
async function isDir(path: string): Promise<boolean> {
  try {
    return (await lstat(path)).isDirectory();
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

const entriesOf = async (path: string): Promise<string[]> => ((await isDir(path)) ? (await readdir(path)).sort() : []);

/**
 * The connections of this database that `pg_stat_activity` names as a server's (`wirebench-server`, its pool, and
 * `wirebench-server-lock`, its lock), other than this one. The command line's are `wirebench-admin` and
 * `wirebench-migrate`, and a bare session's `wirebench-session`, so none of them match. Any role sees another
 * role's `application_name`. A second installation in another schema of the same database counts too, since a
 * session's schema cannot be seen: that refuses, on the safe side.
 */
export async function serverSessions(db: Querier): Promise<readonly ServerSession[]> {
  const rows = await db.query<{ pid: number; name: string }>(
    `select pid, application_name as name from pg_stat_activity
      where datname = current_database() and pid <> pg_backend_pid() and application_name like $1
      order by pid`,
    [`${APPLICATION_NAME}%`],
  );
  return rows.rows;
}

interface SchemaState {
  readonly version: number;
  readonly step: TenancyStep | undefined;
  readonly defaultTenantId: string | undefined;
  readonly tenants: number;
}

async function schemaState(db: Querier): Promise<SchemaState> {
  // Each table is looked for first: a query naming a table that is not there fails when planned.
  const has = async (table: string): Promise<boolean> =>
    (await db.query<{ has: boolean }>('select to_regclass($1) is not null as has', [table])).rows[0]?.has === true;
  const ledger = (await has('schema_migrations'))
    ? await db.query<{ version: number | null }>('select max(version)::int as version from schema_migrations')
    : undefined;
  const state = await readTenancyStep(db);
  const tenants = (await has('tenants'))
    ? await db.query<{ n: number }>('select count(*)::int as n from tenants')
    : undefined;
  return {
    version: ledger?.rows[0]?.version ?? 0,
    step: state?.step,
    defaultTenantId: state?.defaultTenantId,
    tenants: tenants?.rows[0]?.n ?? 0,
  };
}

/**
 * The refusals of spec §19.10 that read the database only, or `nothing` on a database already before slice 4.
 *
 * @throws WirebenchError `tenancy-revert-too-new`, `tenancy-revert-version`, `tenancy-revert-tenants`
 */
function judge(state: SchemaState): 'nothing' | 'go' {
  if (state.version > LAST_TENANCY_MIGRATION) {
    throw refusal(
      'tenancy-revert-too-new',
      `the database is at schema version ${String(state.version)}, newer than ${String(LAST_TENANCY_MIGRATION)}: ` +
        'this command undoes migrations 0020 and 0021 only, and migration 0022 (several server instances) has run ' +
        'since, so this database cannot go back to the previous version. Nothing was changed',
    );
  }
  if (state.step === undefined && state.version <= BEFORE_TENANCY) return 'nothing';
  if (state.step === undefined || state.version !== LAST_TENANCY_MIGRATION) {
    throw refusal(
      'tenancy-revert-version',
      `the database is at schema version ${String(state.version)}: the revert needs migrations 0020 and 0021 both ` +
        'applied. Start this version of the server (or run wirebench-server migrate) once, then revert. Nothing was changed',
    );
  }
  if (state.tenants !== 1) {
    throw refusal(
      'tenancy-revert-tenants',
      `the database has ${String(state.tenants)} tenants: the revert goes back to a server of one. Nothing was changed`,
    );
  }
  return 'go';
}

/** Runs `fn` in one transaction on the lock's own session. */
async function unit<T>(session: Session, fn: () => Promise<T>): Promise<T> {
  await session.query('begin');
  try {
    const result = await fn();
    await session.query('commit');
    return result;
  } catch (error) {
    await session.query('rollback').catch(() => undefined);
    throw error;
  }
}

/** Records the next step, under the file step's lock, only from the step this run found. */
async function advance(session: Session, from: TenancyStep, to: TenancyStep): Promise<void> {
  await unit(session, async () => {
    await session.query('select pg_advisory_xact_lock($1, hashtext(current_schema()))', [FILE_STEP_CLASS]);
    const moved = await session.query('update server_identity set tenancy_step = $1 where tenancy_step = $2', [
      to,
      from,
    ]);
    if (moved.rowCount !== 1) {
      throw refusal('tenancy-revert-raced', `the step changed from ${from} while the revert ran; run it again`);
    }
  });
}

/** What the move back found: the renames and kept repositories still due, and whether anything is there at all. */
export interface RevertMovePlan {
  readonly renames: readonly (readonly [string, string])[];
  readonly kept: readonly string[];
  /** Neither place holds `repos/` or `checkouts/`. */
  readonly empty: boolean;
  /** Where the users' checkouts are now: the tenant's, or the old place once moved back. */
  readonly checkouts: string;
}

/**
 * The move back's pre-flight, reading only: every refusal comes from here, before anything moves.
 *
 * @throws WirebenchError `tenancy-move-conflict`, `tenancy-move-link`, `tenancy-move-cross-device`,
 *   `tenancy-prefix-found`, `tenancy-revert-unknown-files`, and `tenantRootById`'s `tenancy-tenant-path-refused`.
 */
export async function planRevertMove(dataDir: string, tenantId: string, fs: StepFs = realFs): Promise<RevertMovePlan> {
  const base = resolve(dataDir);
  const root = tenantRootById(base, tenantId);
  const tenants = tenantsDir(base);
  // Anything the move does not know would be lost with the tenant's directory, or left in a tree the old version
  // never reads: an operator sorts it out first.
  const unknown = [
    ...(await entriesOf(tenants))
      .filter((name) => name !== tenantId)
      .map((name) => relative(base, join(tenants, name))),
    ...(await entriesOf(root))
      .filter((name) => !TENANT_ENTRIES.includes(name))
      .map((name) => relative(base, join(root, name))),
  ];
  if (unknown.length > 0) {
    throw refusal(
      'tenancy-revert-unknown-files',
      `${listed(unknown)} in ${base} ${unknown.length === 1 ? 'is' : 'are'} not part of the layout the revert moves ` +
        'back: move them out of the way and run the revert again. Nothing was moved',
    );
  }
  const renames: (readonly [string, string])[] = [];
  const conflicts: (readonly [string, string])[] = [];
  let anything = false;
  for (const name of MOVED_DIRS) {
    const from = join(root, name);
    const to = join(base, name);
    const [source, destination] = [await fs.device(from), await fs.device(to)];
    if (source !== undefined || destination !== undefined) anything = true;
    if (source !== undefined && destination !== undefined) conflicts.push([from, to]);
    else if (source !== undefined) renames.push([from, to]);
  }
  const tenantTmp = join(root, OLD_TMP_DIR);
  const kept = (await entriesOf(tenantTmp)).filter((name) => REMOVED.test(name));
  for (const name of kept) {
    const to = join(base, OLD_TMP_DIR, name);
    if ((await fs.device(to)) !== undefined) conflicts.push([join(tenantTmp, name), to]);
  }
  if (conflicts.length > 0) throw conflict(conflicts);

  const links: string[] = [];
  for (const [from] of renames) if (await fs.isLink(from)) links.push(`${relative(base, from)}/`);
  for (const name of kept)
    if (await fs.isLink(join(tenantTmp, name))) links.push(relative(base, join(tenantTmp, name)));
  if (links.length > 0) {
    throw refusal(
      'tenancy-move-link',
      `${listed(links)} in ${base} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}, which the ` +
        'move back does not follow: replace each with the directory itself and run the revert again. Nothing was moved',
    );
  }
  const home = await fs.device(base);
  const tmpHome = (await fs.device(join(base, OLD_TMP_DIR))) ?? home;
  const elsewhere: string[] = [];
  for (const [from] of renames) if ((await fs.device(from)) !== home) elsewhere.push(relative(base, from));
  for (const name of kept) {
    if ((await fs.device(join(tenantTmp, name))) !== tmpHome) elsewhere.push(relative(base, join(tenantTmp, name)));
  }
  if (elsewhere.length > 0) {
    throw refusal(
      'tenancy-move-cross-device',
      `${listed(elsewhere)} in ${base} ${elsewhere.length === 1 ? 'is' : 'are'} on another filesystem than the data ` +
        'directory, and the move back is a rename: put them on its filesystem and run the revert again. Nothing was moved',
    );
  }

  // The previous version reads its checkouts at <dataDir>/checkouts: a state file naming the tenant's path would
  // break there, as the forward step's scan guards the other way.
  const checkouts = (await isDir(join(root, 'checkouts'))) ? join(root, 'checkouts') : join(base, 'checkouts');
  const { found } = await prefixFiles(checkouts, root);
  if (found.length > 0) {
    throw refusal(
      'tenancy-prefix-found',
      `these state files under ${checkouts} name the checkouts directory the revert is about to move: ` +
        `${listed(found)}. Remove the linked projects they name and run the revert again. Nothing was moved`,
    );
  }
  return { renames, kept, empty: !anything, checkouts };
}

/** The rename back, the kept repositories, then the tenant's scratch and directories; every part resumes. */
async function moveBack(
  dataDir: string,
  tenantId: string,
  plan: RevertMovePlan,
  fs: StepFs,
  checkpoint: (part: string) => void,
): Promise<void> {
  const base = resolve(dataDir);
  const root = tenantRootById(base, tenantId);
  for (const [from, to] of plan.renames) {
    await fs.rename(from, to);
    checkpoint(`moved back ${relative(base, to)}`);
  }
  // The old layout's scratch directory, which the old version makes at start-up too.
  await mkdir(join(base, OLD_TMP_DIR), { recursive: true });
  for (const name of plan.kept) {
    await fs.rename(join(root, OLD_TMP_DIR, name), join(base, OLD_TMP_DIR, name));
    checkpoint(`kept ${name}`);
  }
  // Scratch: hosts' directories, run copies, sync's index files and staging, all rebuilt as needed.
  await rm(join(root, OLD_TMP_DIR), { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
  checkpoint('removed the tenant tmp');
  for (const dir of [root, tenantsDir(base)]) {
    try {
      await rmdir(dir);
    } catch (error) {
      if (!isMissing(error)) throw error;
    }
  }
  checkpoint('removed tenants');
}

/**
 * The checks that need the database, in one unit: an empty data directory while the database has data, and a
 * workspace whose repository is in neither place, mean this is not the server's own data directory.
 */
async function checkDataDir(session: Session, dataDir: string, tenantId: string, plan: RevertMovePlan): Promise<void> {
  const base = resolve(dataDir);
  const root = tenantRootById(base, tenantId);
  await unit(session, async () => {
    if (plan.empty && (await databaseHasData(session, tenantId))) throw dataDirEmpty(dataDir);
    await session.query(SET_TENANT, [tenantId]);
    const rows = await session.query<{ id: string }>('select id from workspaces order by id');
    const missing: string[] = [];
    for (const { id } of rows.rows) {
      const repo = `${id}.git`;
      if (!(await isDir(join(base, 'repos', repo))) && !(await isDir(join(root, 'repos', repo)))) missing.push(repo);
    }
    if (missing.length > 0) {
      throw refusal(
        'tenancy-workspaces-missing',
        `${base} has no repository for ${String(missing.length)} of the database's workspaces, at the old place or ` +
          `the new: ${listed(missing)}. This is not the directory the server has been using. Nothing was changed: ` +
          "set WIREBENCH_SERVER_DATA_DIR to the server's own data directory and run the revert again",
      );
    }
  });
}

/**
 * The default tenant's data key, unwrapped, or `undefined` when it has none (nothing was sealed under one).
 *
 * @throws WirebenchError `tenancy-no-root` with a key and no root; `tenancy-data-key-refused`.
 */
async function dataKeyOf(session: Session, tenantId: string, root: Buffer | undefined): Promise<Buffer | undefined> {
  const has = await session.query<{ has: boolean }>('select data_key is not null as has from tenants where id = $1', [
    tenantId,
  ]);
  if (has.rows[0]?.has !== true) return undefined;
  if (root === undefined) {
    throw refusal(
      'tenancy-no-root',
      'the server has a data key, and re-sealing the browser hosts’ secrets and cookie jars under the old key needs ' +
        'WIREBENCH_SERVER_SECRETS_KEY: set it as the server has it and run the revert again. Nothing was changed',
    );
  }
  return storedDataKey(session, tenantId, environmentKeyRoot(root));
}

/** What the revert prints of `back`: counts only. */
export const backLine = (counts: RewrapCounts): string =>
  `re-wrap back: ${String(counts.resealed)} re-sealed under the old key, ${String(counts.already)} already under ` +
  `it, ${String(counts.unopened)} opened under neither key or did not parse (left as they were), ` +
  `${String(counts.skipped)} links or other entries skipped (not followed)`;

/**
 * The refusal for what `back` would leave or left as it was. A value that opens under neither key is unreadable
 * already, so going on loses nothing that could be read; a link not followed may lead to values under the data key,
 * which the revert drops.
 */
function leftAsIs(counts: RewrapCounts, after: string): WirebenchError {
  return refusal(
    'tenancy-revert-unopened',
    `${String(counts.unopened)} values open under neither key or do not parse, and ${String(counts.skipped)} links ` +
      'or other entries are not followed by the re-seal. The first cannot be opened today either; what a link leads ' +
      'to may be sealed under the data key, which the revert drops, and would not open again. Look at them (admin ' +
      'tenancy status counts them), then run the revert again with --accept-unopened to go on without them. ' +
      after,
  );
}

/** Shown in place of the tenant's id in what a refusal prints (ADR-0004's rule for ids in output). */
const TENANT_SHOWN = '<default tenant>';

/** A refusal as printed: the tenant's id, which a path under `tenants/` holds, replaced. */
function withoutTenant(error: unknown, tenantId: string | undefined): unknown {
  if (!(error instanceof WirebenchError) || tenantId === undefined || !error.message.includes(tenantId)) return error;
  return new WirebenchError(error.code, error.message.replaceAll(tenantId, TENANT_SHOWN));
}

/**
 * Runs the revert, or resumes it, and returns once the schema is back at `0019`; with `abort`, gives a revert still
 * at `reverting-keys` back to the forward steps instead.
 *
 * @throws WirebenchError every refusal of the file's header; the step stays where it was.
 */
export async function revertTenancy(options: RevertOptions): Promise<RevertResult> {
  if (options.mode === 'hosted') {
    throw refusal(
      'tenancy-revert-hosted',
      'the revert is for a self-hosted installation: in hosted mode the audit chain is sealed under a key the ' +
        'previous version does not know. Nothing was changed',
    );
  }
  const report = options.report ?? (() => undefined);
  const checkpoint = options.checkpoint ?? (() => undefined);
  const fs = options.fs ?? realFs;
  const session = await openSession(options.url, { applicationName: ADMIN_APPLICATION_NAME });
  // A lock lost with its connection: the file work stops before its next part, not only at the next statement.
  let lost = false;
  session.onLost(() => {
    lost = true;
  });
  const guard = (): void => {
    if (lost) {
      throw refusal(
        'tenancy-revert-session-lost',
        'the database connection that holds the lock was lost; the revert stopped before its next part. Run it ' +
          'again to resume',
      );
    }
  };
  /** After a part: a test may stop here, and a lost session stops the run before the next. */
  const reached = (part: string): void => {
    checkpoint(part);
    guard();
  };
  let tenantId: string | undefined;
  try {
    // The server sessions are told apart by name: a URL that names its sessions itself hides the servers' too.
    const named = await session.query<{ name: string }>("select current_setting('application_name') as name");
    if (named.rows[0]?.name !== ADMIN_APPLICATION_NAME) {
      throw refusal(
        'tenancy-revert-application-name',
        'the database URL sets application_name, so the revert cannot tell a server’s connections from others in ' +
          'pg_stat_activity: remove it from the URLs of the revert and of the servers, and run the revert again. ' +
          'Nothing was changed',
      );
    }
    if (judge(await schemaState(session)) === 'nothing') return { outcome: 'nothing' };
    const lock = await session.query<{ ok: boolean }>(TAKE_EXCLUSIVE, [SERVER_RUNNING_CLASS]);
    if (lock.rows[0]?.ok !== true) {
      throw refusal(
        'tenancy-revert-server-running',
        'a server is running against this database (it holds the server-running lock): stop every server process, ' +
          'including those of another installation in another schema of this database, and run the revert again. ' +
          'Nothing was changed',
      );
    }
    // A server whose lock connection dropped without its knowing still serves until its heartbeat and re-take give
    // up, and then is gone within the drain; only after that does `pg_stat_activity` tell a stopped server from one
    // still running. Every run waits, resumes included (owner ruling, 2026-11-02).
    const waitMs = options.waitMs ?? REVERT_WAIT_MS;
    const until = new Date(Date.now() + waitMs).toISOString().slice(11, 19);
    report(
      `waiting ${String(Math.ceil(waitMs / 1000))} s, until ${until} UTC, for any server that lost its lock to stop`,
    );
    await (options.sleep ?? ((ms: number) => new Promise((done) => setTimeout(done, ms))))(waitMs);
    const sessions = await (options.serverSessions ?? serverSessions)(session);
    if (sessions.length > 0) {
      throw refusal(
        'tenancy-revert-server-running',
        `${String(sessions.length)} server ${sessions.length === 1 ? 'connection is' : 'connections are'} still open ` +
          `to this database (pid ${sessions.map((s) => String(s.pid)).join(', ')}): stop every server process, ` +
          'including those of another installation in another schema of this database, and run the revert again; a ' +
          'connection pooler may also still hold a stopped server’s connections. Nothing was changed',
      );
    }
    // Again, now that nothing else can start: the answers before the lock may be stale.
    const state = await schemaState(session);
    if (judge(state) === 'nothing') return { outcome: 'nothing' };
    tenantId = state.defaultTenantId!;
    let step = state.step!;
    let counts: RewrapCounts | undefined;

    if (options.abort === true) return { outcome: await abort(session, step) };

    if (step === 'files' || step === 'keys' || step === 'done') {
      // Every refusal the next two steps can make, before the first is recorded.
      const plan = await planRevertMove(options.dataDir, tenantId, fs);
      await checkDataDir(session, options.dataDir, tenantId, plan);
      const dataKey = await dataKeyOf(session, tenantId, options.root);
      if (dataKey !== undefined && options.acceptUnopened !== true) {
        // `back` as a dry run: what it would leave as it is refuses here, while nothing has changed (review I1).
        const would = await rewrap(plan.checkouts, { root: options.root!, dataKey }, 'back', { dryRun: true });
        if (would.unopened + would.skipped > 0) throw leftAsIs(would, 'Nothing was changed');
      }
      await advance(session, step, 'reverting-keys');
      step = 'reverting-keys';
      reached('recorded reverting-keys');
    }
    if (step === 'reverting-keys') {
      const plan = await planRevertMove(options.dataDir, tenantId, fs);
      await checkDataDir(session, options.dataDir, tenantId, plan);
      const dataKey = await dataKeyOf(session, tenantId, options.root);
      // No data key, nothing sealed under one: slice 2's blobs are still under the old key.
      if (dataKey !== undefined) {
        // Strict: a file it cannot read or write stops the revert, which resumes here (carried note 2).
        counts = await rewrap(plan.checkouts, { root: options.root!, dataKey }, 'back', {
          checkpoint: () => {
            reached('re-wrapped a file back');
          },
        });
        report(backLine(counts));
        // The backstop: something that appeared since the dry run. The step stays here; `--abort` goes forward again.
        if (counts.unopened + counts.skipped > 0 && options.acceptUnopened !== true) {
          throw leftAsIs(
            counts,
            'The revert stopped at reverting-keys, before the files or the database changed; or run it with --abort ' +
              'to give the upgrade back to the next server start',
          );
        }
      }
      // `back` wrote every file durably before it returned (`writeFileDurably`), so the key may go from here on.
      await advance(session, 'reverting-keys', 'reverting-files');
      step = 'reverting-files';
      reached('recorded reverting-files');
    }
    if (step === 'reverting-files') {
      const plan = await planRevertMove(options.dataDir, tenantId, fs);
      await checkDataDir(session, options.dataDir, tenantId, plan);
      await moveBack(options.dataDir, tenantId, plan, fs, reached);
      report('data directory: back in the layout before this version');
      await advance(session, 'reverting-files', 'reverting-rows');
      step = 'reverting-rows';
      reached('recorded reverting-rows');
    }
    if (step === 'reverting-rows') {
      const sql = await readFile(REVERT_SQL_FILE, 'utf8');
      await unit(session, async () => {
        // The owner's own limits (a managed database often sets one) would roll the unit back every time.
        await session.query("set local statement_timeout = '0'");
        await session.query("set local lock_timeout = '0'");
        await session.query("set local idle_in_transaction_session_timeout = '0'");
        await session.query("set local maintenance_work_mem = '256MB'");
        await session.query('select pg_advisory_xact_lock($1, hashtext(current_schema()))', [FILE_STEP_CLASS]);
        const now = await readTenancyStep(session);
        if (now?.step !== 'reverting-rows') {
          throw refusal('tenancy-revert-raced', 'the step changed while the revert ran; run it again');
        }
        await session.query(sql);
        checkpoint('rows reverted, not committed');
      });
      report(`database: back at schema version ${String(BEFORE_TENANCY)}`);
    }
    return { outcome: 'reverted', ...(counts !== undefined ? { counts } : {}) };
  } catch (error) {
    throw withoutTenant(error, tenantId);
  } finally {
    // Closing the session releases the lock with it.
    await session.close();
  }
}

/**
 * `--abort`: a revert at `reverting-keys` has changed nothing but blobs, re-sealed under the old key while the data
 * key is still there. Recording `files` hands the installation back to the forward steps, which are idempotent: the
 * move finds everything already in place, and the keys step re-seals under the data key what `back` moved (the
 * re-arm the forward step already allows). From `reverting-files` on, files have moved back: only finishing is safe.
 *
 * @throws WirebenchError `tenancy-revert-abort-too-late`
 */
async function abort(session: Session, step: TenancyStep): Promise<'aborted' | 'not-reverting'> {
  if (step === 'files' || step === 'keys' || step === 'done') return 'not-reverting';
  if (step !== 'reverting-keys') {
    throw refusal(
      'tenancy-revert-abort-too-late',
      `the revert is at ${step}: the data directory has started moving back, so it can only be finished. Run the ` +
        'revert again without --abort. Nothing was changed',
    );
  }
  await advance(session, 'reverting-keys', 'files');
  return 'aborted';
}
