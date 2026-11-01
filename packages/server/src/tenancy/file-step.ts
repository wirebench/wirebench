/**
 * The self-hosted migration's second forward step (hosted edition spec §19.10), driven by
 * `server_identity.tenancy_step`, which `0020` sets to `files` on every installation, fresh or upgraded:
 *
 * - **`files`**: rename `repos/` and `checkouts/` into the default tenant's root; move the `tmp/removed-…`
 *   repositories (deleted workspaces, kept on purpose) into its `tmp/` and delete the rest of the old `tmp/`,
 *   scratch that is rebuilt as needed; then `keys`.
 * - **`keys`**: the data key and the re-wrap (§19.7) are plan Task 24's. Until then the step has nothing to do
 *   and goes straight on to `done`.
 *
 * Every refusal comes from the pre-flight, before anything moves, so a refused step leaves the data directory as it
 * was: both locations of a directory present (`tenancy-move-conflict`), a source on another filesystem than the
 * data directory, where a rename cannot go (`tenancy-move-cross-device`), a state file naming the old checkouts
 * path (`tenancy-prefix-found`), and an empty data directory while the database has data, which is a data
 * directory that is not the server's own (`tenancy-data-dir-empty`).
 *
 * Every part resumes. A rename is due when its source is present and its destination absent, and done in the
 * reverse case. The step runs inside one transaction holding an advisory lock for this schema, so two processes
 * starting at once never move the same directory, and a crash leaves `tenancy_step` where it was, for the next
 * start-up to finish.
 */
import { lstat, mkdir, readdir, readFile, realpath, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../db/querier.js';
import { TENANTS_DIR, tenantRootById } from './paths.js';
import { renameWithRetry } from './rename.js';
import { SET_TENANT } from './tenant-db.js';

export const TENANCY_STEPS = ['files', 'keys', 'done', 'reverting-keys', 'reverting-files', 'reverting-rows'] as const;
export type TenancyStep = (typeof TENANCY_STEPS)[number];

export interface TenancyStepState {
  readonly step: TenancyStep;
  readonly defaultTenantId: string;
}

/** The directories the step renames, from the data directory's root into the default tenant's. */
export const MOVED_DIRS = ['repos', 'checkouts'] as const;
/** The old scratch directory: its `removed-…` repositories move, the rest is deleted. */
export const OLD_TMP_DIR = 'tmp';
/** A deleted workspace's repository, which the store moved aside rather than deleting. */
const REMOVED = /^removed-/;
/** What the data directory's root may hold, before the step and after it. */
export const KNOWN_ROOT_ENTRIES: readonly string[] = [...MOVED_DIRS, OLD_TMP_DIR, 'no-hooks', TENANTS_DIR];

/**
 * The host's state files that can hold an absolute path under its checkout, relative to one user's checkout (`*` is
 * one workspace id). A linked project's `path` is in the workspace manifest, a server workspace's copy and base, and
 * the share and sync state name the workspace's place. History, session logs, cookie jars and unsaved drafts hold
 * whatever a response or a terminal printed, so they are not read: a path there is text, not state.
 */
export const STATE_FILES: readonly (readonly string[])[] = [
  ['workspace-state.json'],
  ['workspaces', '*', 'workspace.yaml'],
  ['workspaces', '*', 'share.yaml'],
  ['workspaces', '*', 'tree', 'workspace.yaml'],
  ['workspaces', '*', 'server', 'state.yaml'],
  ['workspaces', '*', 'server', 'base', 'workspace.yaml'],
];
/** A state file larger than this is not one the host writes: skipped, and counted in the step's report. */
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;
/** How many files a refusal names before it says how many more there are. */
const MAX_LISTED = 20;
/** The advisory-lock class of the step; the schema's hash is the other half, as for the running lock. */
export const FILE_STEP_CLASS = 0x57424653; // "WBFS"

/** A test seam: called after each part of the step has happened, so a test can stop the step there. */
export type StepCheckpoint = (part: string) => void;

/** The filesystem calls the pre-flight and the moves make, injectable so a test can fake another device. */
export interface StepFs {
  /** The device a path is on (`lstat`'s `dev`), or `undefined` when nothing is there. */
  readonly device: (path: string) => Promise<number | undefined>;
  readonly rename: (from: string, to: string) => Promise<void>;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

const realFs: StepFs = {
  device: async (path) => {
    try {
      return (await lstat(path)).dev;
    } catch (error) {
      if (isMissing(error)) return undefined;
      throw error;
    }
  },
  rename: (from, to) => renameWithRetry(from, to),
};

/** The step and the default tenant's id, or `undefined` on a database before `0020`. */
export async function readTenancyStep(db: Querier): Promise<TenancyStepState | undefined> {
  const column = await db.query<{ has: boolean }>(
    `select exists (select 1 from information_schema.columns
        where table_schema = current_schema() and table_name = 'server_identity' and column_name = 'tenancy_step') as has`,
  );
  if (column.rows[0]?.has !== true) return undefined;
  const rows = await db.query<{ step: TenancyStep | null; defaultTenantId: string | null }>(
    'select tenancy_step as step, default_tenant_id::text as "defaultTenantId" from server_identity',
  );
  const row = rows.rows[0];
  if (row?.step == null || row.defaultTenantId == null) return undefined;
  return { step: row.step, defaultTenantId: row.defaultTenantId };
}

/** `names`, at most {@link MAX_LISTED} of them, then how many more. */
const listed = (names: readonly string[]): string =>
  names.length <= MAX_LISTED
    ? names.join(', ')
    : `${names.slice(0, MAX_LISTED).join(', ')} and ${String(names.length - MAX_LISTED)} more`;

const conflict = (paths: readonly (readonly [string, string])[]): WirebenchError =>
  new WirebenchError(
    'tenancy-move-conflict',
    `both the old and the new location exist: ${paths.map(([from, to]) => `${from} and ${to}`).join('; ')}. ` +
      'Keep the one that holds the data, move the other away, and start again. Nothing was moved',
  );

/** What the pre-flight found: the renames and kept repositories that are due, and the files it skipped. */
export interface MovePlan {
  readonly renames: readonly (readonly [string, string])[];
  readonly kept: readonly string[];
  /** State files over the size cap, which the scan did not read (relative to `checkouts/`). */
  readonly skipped: readonly string[];
  /** Whether anything at all is there to move, or already moved: a data directory with no sign of the server. */
  readonly empty: boolean;
}

/**
 * The pre-flight: every check the step makes, before anything moves. It only reads.
 *
 * @throws WirebenchError `tenancy-move-conflict`, `tenancy-move-cross-device` or `tenancy-prefix-found`.
 */
export async function planMove(dataDir: string, defaultTenantId: string, fs: StepFs = realFs): Promise<MovePlan> {
  const base = resolve(dataDir);
  const root = tenantRootById(base, defaultTenantId);
  const renames: (readonly [string, string])[] = [];
  const conflicts: (readonly [string, string])[] = [];
  let anything = false;
  for (const name of MOVED_DIRS) {
    const from = join(base, name);
    const to = join(root, name);
    const [source, destination] = [await fs.device(from), await fs.device(to)];
    if (source !== undefined || destination !== undefined) anything = true;
    if (source !== undefined && destination !== undefined) conflicts.push([from, to]);
    else if (source !== undefined) renames.push([from, to]);
  }
  const oldTmp = join(base, OLD_TMP_DIR);
  const tmpNames = (await fs.device(oldTmp)) === undefined ? [] : await readdir(oldTmp);
  const kept = tmpNames.filter((name) => REMOVED.test(name));
  for (const name of kept) {
    const to = join(root, 'tmp', name);
    if ((await fs.device(to)) !== undefined) conflicts.push([join(oldTmp, name), to]);
  }
  if (conflicts.length > 0) throw conflict(conflicts);

  // A rename never crosses a filesystem: a source on another device (a mount point, say) would fail with EXDEV after
  // the others had moved. The destinations are under tenants/ (or, before it exists, the data directory itself).
  const home = (await fs.device(join(base, TENANTS_DIR))) ?? (await fs.device(base));
  const elsewhere: string[] = [];
  for (const [from] of renames) if ((await fs.device(from)) !== home) elsewhere.push(relative(base, from));
  for (const name of kept) if ((await fs.device(join(oldTmp, name))) !== home) elsewhere.push(`tmp/${name}`);
  if (elsewhere.length > 0) {
    throw new WirebenchError(
      'tenancy-move-cross-device',
      `${listed(elsewhere)} in ${base} ${elsewhere.length === 1 ? 'is' : 'are'} on another filesystem than the data ` +
        'directory, and the move is a rename: put them on its filesystem (or mount the volume at the data directory ' +
        'itself) and start again. Nothing was moved',
    );
  }

  // The scan, before the moves: wherever checkouts/ is now, the source or the destination.
  const checkouts = renames.some(([from]) => from === join(base, 'checkouts'))
    ? join(base, 'checkouts')
    : join(root, 'checkouts');
  const { found, skipped } = await oldPrefixFiles(base, checkouts);
  if (found.length > 0) {
    throw new WirebenchError(
      'tenancy-prefix-found',
      `these state files under ${checkouts} name the old checkouts directory, which is about to move: ` +
        `${listed(found)}. Remove the linked projects they name and start again. Nothing was moved`,
    );
  }
  return { renames, kept, skipped, empty: !anything };
}

/**
 * The `files` part: the pre-flight, then the moves. Refuses before anything moves; see {@link planMove}.
 */
export async function moveFiles(
  dataDir: string,
  defaultTenantId: string,
  options: { readonly checkpoint?: StepCheckpoint; readonly fs?: StepFs; readonly plan?: MovePlan } = {},
): Promise<MovePlan> {
  const fs = options.fs ?? realFs;
  const checkpoint = options.checkpoint ?? (() => undefined);
  const base = resolve(dataDir);
  const plan = options.plan ?? (await planMove(base, defaultTenantId, fs));
  const root = tenantRootById(base, defaultTenantId);
  await mkdir(root, { recursive: true });
  for (const [from, to] of plan.renames) {
    await fs.rename(from, to);
    checkpoint(`renamed ${relative(base, from)}`);
  }
  const oldTmp = join(base, OLD_TMP_DIR);
  if (plan.kept.length > 0) await mkdir(join(root, 'tmp'), { recursive: true });
  for (const name of plan.kept) {
    await fs.rename(join(oldTmp, name), join(root, 'tmp', name));
    checkpoint(`kept ${name}`);
  }
  await rm(oldTmp, { recursive: true, force: true });
  checkpoint('removed tmp');
  return plan;
}

/** `name` as the files the host writes may spell it: native, with `/`, and JSON-escaped (`\\` for each `\`). */
function spellings(path: string): string[] {
  const forward = path.split(sep).join('/');
  const escaped = path.replaceAll('\\', '\\\\');
  return [...new Set([path, forward, escaped])];
}

/** On Windows a drive letter's case varies between writers, so the scan compares there without case. */
const fold = (text: string): string => (process.platform === 'win32' ? text.toLowerCase() : text);

/** Every file under `checkouts` that {@link STATE_FILES} names, as absolute paths. */
async function stateFiles(checkouts: string): Promise<string[]> {
  const users = await readdir(checkouts, { withFileTypes: true }).catch((error: unknown) => {
    if (isMissing(error)) return [];
    throw error;
  });
  const files: string[] = [];
  const expand = async (dir: string, parts: readonly string[]): Promise<void> => {
    const [first, ...rest] = parts;
    if (first === undefined) return;
    if (first !== '*') {
      const path = join(dir, first);
      if (rest.length === 0) {
        const info = await lstat(path).catch(() => undefined);
        if (info?.isFile() === true) files.push(path);
      } else {
        await expand(path, rest);
      }
      return;
    }
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    for (const entry of entries) if (entry.isDirectory()) await expand(join(dir, entry.name), rest);
  };
  for (const user of users) {
    if (!user.isDirectory()) continue;
    for (const pattern of STATE_FILES) await expand(join(checkouts, user.name), pattern);
  }
  return files;
}

/**
 * The users' state files ({@link STATE_FILES}) under `checkouts` that hold the old absolute prefix
 * `<dataDir>/checkouts/`, and those skipped for their size; both relative to `checkouts`, `/`-separated. A server host
 * cannot create a linked project, but a file that holds one would break once the directory moved.
 */
export async function oldPrefixFiles(
  dataDir: string,
  checkouts: string,
): Promise<{ readonly found: string[]; readonly skipped: string[] }> {
  const base = resolve(dataDir);
  const prefixes = [...new Set([base, await realpath(base).catch(() => base)])].map((dir) =>
    join(dir, 'checkouts', ''),
  );
  const needles = [...new Set(prefixes.flatMap(spellings))].map(fold);
  const found: string[] = [];
  const skipped: string[] = [];
  for (const path of await stateFiles(checkouts)) {
    const name = relative(checkouts, path).split(sep).join('/');
    if ((await lstat(path)).size > MAX_STATE_FILE_BYTES) {
      skipped.push(name);
      continue;
    }
    const text = fold(await readFile(path, 'utf8'));
    if (needles.some((needle) => text.includes(needle))) found.push(name);
  }
  return { found: found.sort(), skipped: skipped.sort() };
}

/**
 * Whether the default tenant has workspaces or has had browser sign-ins (each of which may own a host checkout):
 * what an empty data directory contradicts.
 */
async function databaseHasData(tx: Querier, defaultTenantId: string): Promise<boolean> {
  await tx.query(SET_TENANT, [defaultTenantId]);
  const rows = await tx.query<{ has: boolean }>(
    "select exists (select 1 from workspaces) or exists (select 1 from device_tokens where kind = 'browser') as has",
  );
  return rows.rows[0]?.has === true;
}

/**
 * Refuses a data directory that still holds `repos/` or `checkouts/` at its root while the database records the move
 * as made: the move then ran against another directory (a `migrate` on an image whose own `/data` was not the
 * volume, say), and serving would hide every repository. Only reads; run it before the migrations.
 *
 * @throws WirebenchError `tenancy-files-left-behind`
 */
export async function checkNothingLeftBehind(db: Querier, dataDir: string): Promise<void> {
  const state = await readTenancyStep(db);
  if (state === undefined || (state.step !== 'keys' && state.step !== 'done')) return;
  const base = resolve(dataDir);
  const left: string[] = [];
  for (const name of MOVED_DIRS) if ((await realFs.device(join(base, name))) !== undefined) left.push(`${name}/`);
  if (left.length === 0) return;
  const root = join(TENANTS_DIR, state.defaultTenantId);
  throw new WirebenchError(
    'tenancy-files-left-behind',
    `${base} still holds ${left.join(' and ')} from before this version, but the database records the data ` +
      'directory as moved: the move ran against another directory, such as a migrate run without this volume ' +
      `mounted. Nothing was changed. Stop the server, move ${left.join(' and ')} into ${root}/ in the data ` +
      'directory (remove any empty directories of the same name there first), and start again',
  );
}

/** The data directory holds nothing of the server's while the database has data: it is not the server's own. */
export const dataDirEmpty = (dataDir: string): WirebenchError =>
  new WirebenchError(
    'tenancy-data-dir-empty',
    `the data directory ${resolve(dataDir)} holds no repositories or checkouts, but the database has workspaces or ` +
      "browser sign-ins: WIREBENCH_SERVER_DATA_DIR must name the server's own data directory, with its volume " +
      'mounted. Nothing was moved; the step stays due',
  );

export interface RunStepsOptions {
  readonly checkpoint?: StepCheckpoint;
  readonly fs?: StepFs;
  /** Told of the state files the scan skipped for their size; names only, never their content. */
  readonly onSkipped?: (names: readonly string[]) => void;
}

/**
 * Runs whatever of the forward steps is due and returns the step it ends at, or `undefined` on a database before
 * `0020`. A step of a revert refuses with `tenancy-reverting`: a forward start-up never runs during one.
 *
 * The unit stays open across the moves, which is what keeps a second process off them (the lock) and the step's
 * value in step with the files (the commit). `idle_in_transaction_session_timeout` is lifted for it, so a long scan
 * or `rm` is not cut short by the server; a cut-short unit would roll back, and the next start resumes.
 *
 * @throws WirebenchError `tenancy-data-dir-empty` (the step stays `files`) and every refusal of {@link planMove}.
 */
export async function runTenancySteps(
  db: Database,
  dataDir: string,
  options: RunStepsOptions = {},
): Promise<TenancyStep | undefined> {
  return db.transaction(async (tx) => {
    await tx.query("set local idle_in_transaction_session_timeout = '0'");
    await tx.query('select pg_advisory_xact_lock($1, hashtext(current_schema()))', [FILE_STEP_CLASS]);
    const state = await readTenancyStep(tx);
    if (state === undefined) return undefined;
    let step = state.step;
    if (step.startsWith('reverting-')) {
      throw new WirebenchError('tenancy-reverting', `admin tenancy revert has not finished (step ${step})`);
    }
    const advance = async (from: TenancyStep, to: TenancyStep): Promise<void> => {
      await tx.query('update server_identity set tenancy_step = $1 where tenancy_step = $2', [to, from]);
      step = to;
    };
    if (step === 'files') {
      const fs = options.fs ?? realFs;
      const plan = await planMove(dataDir, state.defaultTenantId, fs);
      if (plan.skipped.length > 0) options.onSkipped?.(plan.skipped);
      if (plan.empty && (await databaseHasData(tx, state.defaultTenantId))) throw dataDirEmpty(dataDir);
      await moveFiles(dataDir, state.defaultTenantId, {
        fs,
        plan,
        ...(options.checkpoint ? { checkpoint: options.checkpoint } : {}),
      });
      await advance('files', 'keys');
    }
    if (step === 'keys') {
      // Plan Task 24: the default tenant's data key and the re-wrap go here, before `done`.
      await advance('keys', 'done');
    }
    return step;
  });
}
