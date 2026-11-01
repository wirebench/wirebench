/**
 * The self-hosted migration's second forward step (hosted edition spec §19.10), driven by
 * `server_identity.tenancy_step`, which `0020` sets to `files` on every installation, fresh or upgraded:
 *
 * - **`files`**: rename `repos/` and `checkouts/` into the default tenant's root; move the `tmp/removed-…`
 *   repositories (deleted workspaces, kept on purpose) into its `tmp/` and delete the rest of the old `tmp/`,
 *   scratch that is rebuilt as needed; then `keys`.
 * - **`keys`** (§19.7, plan Task 24): with the root (`WIREBENCH_SERVER_SECRETS_KEY`), make the default tenant's
 *   data key, re-wrap every blob of its users' checkouts under it (`rewrap.ts`), then `done`. Without the root the
 *   step stays `keys`: nothing was sealed without one, and the host module, the only reader, cannot be on. A `done`
 *   with no data key while the root is set is `keys` again, so a root configured after the upgrade gets its key and
 *   its re-wrap. The step can also come back to `keys` after a re-arm to `files`, so the re-wrap is idempotent: a
 *   blob already under the data key is left, and counted as such.
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
import { lstat, mkdir, readdir, readFile, realpath, rm, rmdir } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../db/querier.js';
import { environmentKeyRoot, TenantKeys } from './keys.js';
import { TENANTS_DIR, tenantRootById } from './paths.js';
import { rewrap, type RewrapCounts } from './rewrap.js';
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

/** The filesystem calls the pre-flight and the moves make, injectable so a test can fake another device or a link. */
export interface StepFs {
  /** The device a path is on (`lstat`'s `dev`), or `undefined` when nothing is there. */
  readonly device: (path: string) => Promise<number | undefined>;
  /** Whether the entry at a path is itself a symbolic link (`lstat`, never followed). */
  readonly isLink: (path: string) => Promise<boolean>;
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
  isLink: async (path) => {
    try {
      return (await lstat(path)).isSymbolicLink();
    } catch (error) {
      if (isMissing(error)) return false;
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

  // A link would move as a link, and the new layout refuses links (`tenantPaths`), so every request would then be
  // refused with the step already done: /data/repos -> /mnt/big/repos is a common way to put repositories on a
  // bigger disk (Task 22 fix-round review I1).
  const links: string[] = [];
  for (const [from] of renames) if (await fs.isLink(from)) links.push(`${relative(base, from)}/`);
  for (const name of kept) if (await fs.isLink(join(oldTmp, name))) links.push(`tmp/${name}`);
  if (links.length > 0) {
    throw new WirebenchError(
      'tenancy-move-link',
      `${listed(links)} in ${base} ${links.length === 1 ? 'is a symbolic link' : 'are symbolic links'}, and the new ` +
        `layout does not follow links: replace each with the directory itself, or mount the volume at its new place ` +
        `under ${join(base, TENANTS_DIR, defaultTenantId)}, and start again. Nothing was moved`,
    );
  }

  // A rename never crosses a filesystem: a source on another device (a mount point, say) would fail with EXDEV after
  // the others had moved. Each destination's device is the nearest of its parents that exists: the tenant's root (or
  // its tmp/), tenants/, or the data directory itself.
  const home = (await fs.device(root)) ?? (await fs.device(join(base, TENANTS_DIR))) ?? (await fs.device(base));
  const tmpHome = (await fs.device(join(root, 'tmp'))) ?? home;
  const elsewhere: string[] = [];
  for (const [from] of renames) if ((await fs.device(from)) !== home) elsewhere.push(relative(base, from));
  for (const name of kept) if ((await fs.device(join(oldTmp, name))) !== tmpHome) elsewhere.push(`tmp/${name}`);
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
  // Retried, as the renames are: Windows refuses a delete while a transient handle is open (review m4).
  await rm(oldTmp, { recursive: true, force: true, maxRetries: 5, retryDelay: 50 });
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

/** What a move recorded as made left at the data directory's root, and whether the step can simply run again. */
interface LeftBehind {
  /** `repos/`, `checkouts/` and `tmp/`, those still at the root. */
  readonly left: readonly string[];
  /** Every destination is absent or an empty directory, so re-arming the step and moving is safe. */
  readonly rearmable: boolean;
  /** The empty destination directories re-arming removes first, so the pre-flight sees no conflict. */
  readonly emptyDestinations: readonly string[];
  /** The default tenant's workspaces whose `<id>.git` is neither at the root's `repos/` nor at the new place. */
  readonly missing: readonly string[];
}

/**
 * What a move recorded as made (`keys` or `done`) left at the root. A root `tmp/` counts: the new layout never writes
 * there (every scratch path is `tenants/<id>/tmp`), so one means a move cut short after both directories had moved,
 * with the kept `removed-…` repositories still in it (Task 22 fix round 2 review I1). Its entries have no
 * destination to judge here: the pre-flight refuses a `removed-…` that is in both places.
 *
 * Re-arming also needs every workspace of the database to have its repository here, at the old place or the new
 * (review m2): a pre-upgrade copy of the data directory mounted after the move lacks the workspaces made since, and
 * is refused rather than moved and served.
 */
async function leftBehind(tx: Querier, dataDir: string, defaultTenantId: string): Promise<LeftBehind> {
  const base = resolve(dataDir);
  const root = tenantRootById(base, defaultTenantId);
  const left: string[] = [];
  const emptyDestinations: string[] = [];
  let rearmable = true;
  for (const name of MOVED_DIRS) {
    if ((await realFs.device(join(base, name))) === undefined) continue;
    left.push(`${name}/`);
    const to = join(root, name);
    if ((await realFs.device(to)) === undefined) continue;
    const empty = !(await realFs.isLink(to)) && (await readdir(to).catch(() => ['?'])).length === 0;
    if (empty) emptyDestinations.push(to);
    else rearmable = false;
  }
  if ((await realFs.device(join(base, OLD_TMP_DIR))) !== undefined) left.push(`${OLD_TMP_DIR}/`);
  const missing: string[] = [];
  if (left.length > 0 && rearmable) {
    await tx.query(SET_TENANT, [defaultTenantId]);
    const rows = await tx.query<{ id: string }>('select id from workspaces where tenant_id = $1 order by id', [
      defaultTenantId,
    ]);
    for (const { id } of rows.rows) {
      const repo = `${id}.git`;
      const here =
        (await realFs.device(join(base, 'repos', repo))) !== undefined ||
        (await realFs.device(join(root, 'repos', repo))) !== undefined;
      if (!here) missing.push(repo);
    }
  }
  return { left, rearmable, emptyDestinations, missing };
}

/** `left` as a phrase: "repos/ and checkouts/", with the verb that goes with it. */
const leftPhrase = (left: readonly string[]): string => `${left.join(' and ')} ${left.length === 1 ? 'is' : 'are'}`;

const leftBehindError = (dataDir: string, defaultTenantId: string, left: readonly string[]): WirebenchError => {
  const root = join(TENANTS_DIR, defaultTenantId);
  const dirs = left.filter((name) => name !== `${OLD_TMP_DIR}/`);
  return new WirebenchError(
    'tenancy-files-left-behind',
    `${resolve(dataDir)} still holds ${left.join(' and ')} from before this version, but the database records the ` +
      'data directory as moved, and the new places already hold data: the move ran against another directory, ' +
      'such as a migrate run without this volume mounted, and the server has been used since. Nothing was ' +
      `changed. Stop the server and merge ${dirs.join(' and ')} into ${root}/ by hand, the kept tmp/removed-… ` +
      `repositories into ${root}/tmp/, then start again`,
  );
};

const workspacesMissingError = (dataDir: string, left: readonly string[], missing: readonly string[]): WirebenchError =>
  new WirebenchError(
    'tenancy-workspaces-missing',
    `${resolve(dataDir)} still holds ${left.join(' and ')} from before this version, and the database records the ` +
      `data directory as moved, but it has no repository for ${String(missing.length)} of the database's ` +
      `workspaces, at the old place or the new: ${listed(missing)}. This is not the directory the server has been ` +
      "using (an older copy of it, say). Nothing was changed: mount the server's current data directory and start " +
      'again',
  );

/** What start-up and `migrate` say when the step re-arms itself: the directories only, never a tenant or a value. */
export const rearmLine = (left: readonly string[]): string =>
  `data directory: the move to the new layout is recorded as made, but ${leftPhrase(left)} still at the root ` +
  '(a move made against another directory, or one cut short); moving them now';

/**
 * Refuses a data directory that still holds `repos/`, `checkouts/` or `tmp/` at its root while the database records
 * the move as made, when only a person can sort it out: the new places already hold data
 * (`tenancy-files-left-behind`), or a workspace of the database has no repository here
 * (`tenancy-workspaces-missing`). Otherwise it lets the start go on, and returns what is left: the step then re-arms
 * itself and moves, with every check of its pre-flight (`runTenancySteps`), and `migrate --check` counts that as
 * pending. Only reads; run it before the migrations.
 *
 * @throws WirebenchError `tenancy-files-left-behind`, `tenancy-workspaces-missing`
 */
export async function checkNothingLeftBehind(db: Database, dataDir: string): Promise<readonly string[]> {
  const state = await readTenancyStep(db);
  if (state === undefined || (state.step !== 'keys' && state.step !== 'done')) return [];
  const found = await db.transaction((tx) => leftBehind(tx, dataDir, state.defaultTenantId));
  if (found.left.length === 0) return [];
  if (!found.rearmable) throw leftBehindError(dataDir, state.defaultTenantId, found.left);
  if (found.missing.length > 0) throw workspacesMissingError(dataDir, found.left, found.missing);
  return found.left;
}

/**
 * The step still due, or `undefined` when nothing is (`migrate --check`, spec §19.10). `keys` without a root is not
 * due: it waits for one, and blocks nothing a server without the browser client runs. `done` without a data key is
 * `keys` once a root is set.
 */
export async function dueStep(db: Querier, root: Buffer | undefined): Promise<TenancyStep | undefined> {
  const state = await readTenancyStep(db);
  if (state === undefined) return undefined;
  if (state.step === 'keys' && root === undefined) return undefined;
  if (state.step === 'done') {
    if (root === undefined) return undefined;
    const key = await db.query<{ has: boolean }>('select data_key is not null as has from tenants where id = $1', [
      state.defaultTenantId,
    ]);
    return key.rows[0]?.has === true ? undefined : 'keys';
  }
  return state.step;
}

/** What start-up and `migrate` say of the keys step's outcome: counts only. */
export function rewrapLine(counts: RewrapCounts): string {
  return (
    `re-wrap: ${counts.resealed} re-sealed under the data key, ${counts.already} already under it, ` +
    `${counts.unopened} opened under neither key and were left as they were`
  );
}

/** Why the step stopped at `keys`. */
export const KEYS_WAIT =
  'the data key and the one-time re-wrap wait for WIREBENCH_SERVER_SECRETS_KEY; nothing is sealed without it, and no browser host opens until it is set';

/** The data directory holds nothing of the server's while the database has data: it is not the server's own. */
export const dataDirEmpty = (dataDir: string): WirebenchError =>
  new WirebenchError(
    'tenancy-data-dir-empty',
    `the data directory ${resolve(dataDir)} holds no repositories or checkouts, but the database has workspaces or ` +
      "browser sign-ins: WIREBENCH_SERVER_DATA_DIR must name the server's own data directory, with its volume " +
      'mounted. Nothing was moved; the step stays due',
  );

export interface RunStepsOptions {
  /**
   * `WIREBENCH_SERVER_SECRETS_KEY`: what wraps the default tenant's data key and sealed slice 2's blobs. Without it
   * the step stops at `keys`.
   */
  readonly root?: Buffer;
  /** Told of the re-wrap's counts, once it has run; counts only, never a file or a value. */
  readonly onRewrap?: (counts: RewrapCounts) => void;
  readonly checkpoint?: StepCheckpoint;
  readonly fs?: StepFs;
  /** Told of the state files the scan skipped for their size; names only, never their content. */
  readonly onSkipped?: (names: readonly string[]) => void;
  /**
   * Told when a move recorded as made re-arms itself, with what is still at the root (`repos/`, `checkouts/`,
   * `tmp/`): directory names only. Called inside the unit, before the move; a refusal after it rolls the re-arm back.
   */
  readonly onRearmed?: (left: readonly string[]) => void;
}

/**
 * Runs whatever of the forward steps is due and returns the step it ends at, or `undefined` on a database before
 * `0020`. A step of a revert refuses with `tenancy-reverting`: a forward start-up never runs during one.
 *
 * The unit stays open across the moves, which is what keeps a second process off them (the lock) and the step's
 * value in step with the files (the commit). `idle_in_transaction_session_timeout` is lifted for it, so a long scan
 * or `rm` is not cut short by the server; a cut-short unit would roll back, and the next start resumes.
 *
 * The data key is made over `db`, outside the step's unit, by `TenantKeys`'s compare-and-set: it is committed before
 * any blob is sealed under it, so a step rolled back after some files were re-wrapped never loses the key they need.
 *
 * @throws WirebenchError `tenancy-data-dir-empty` (the step stays `files`), every refusal of {@link planMove}, and
 *   `TenantKeys.dataKey`'s: `tenancy-data-key-refused` when the stored key does not open under `root`,
 *   `tenancy-tenant-id-invalid` for a default tenant id that is not canonical (the step stays `keys`).
 */
export async function runTenancySteps(
  db: Database,
  dataDir: string,
  options: RunStepsOptions = {},
): Promise<TenancyStep | undefined> {
  return db.transaction(async (tx) => {
    await tx.query("set local idle_in_transaction_session_timeout = '0'");
    // PostgreSQL 17's whole-transaction timeout, unknown before it (review m1).
    const version = await tx.query<{ num: number }>("select current_setting('server_version_num')::int as num");
    if ((version.rows[0]?.num ?? 0) >= 170000) await tx.query("set local transaction_timeout = '0'");
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
    // A move recorded against another directory, with this one's sources still at the root (review C1 and m2 of
    // the fix round), or a re-armed move cut short after both directories had moved, with the root tmp/ left
    // (round 2 review I1): when the new places are absent or empty and every workspace's repository is here, the
    // step re-arms and moves, through its pre-flight. Safe: nothing has been written at the new places, `keys` is
    // idempotent, and a refusal or a kill below rolls the reset back with the unit, so the next start finds what is
    // still at the root and re-arms again.
    if (step === 'keys' || step === 'done') {
      const found = await leftBehind(tx, dataDir, state.defaultTenantId);
      if (found.left.length > 0) {
        if (!found.rearmable) throw leftBehindError(dataDir, state.defaultTenantId, found.left);
        if (found.missing.length > 0) throw workspacesMissingError(dataDir, found.left, found.missing);
        options.onRearmed?.(found.left);
        for (const dir of found.emptyDestinations) await rmdir(dir);
        await tx.query("update server_identity set tenancy_step = 'files' where tenancy_step = $1", [step]);
        step = 'files';
      }
    }
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
    const root = options.root;
    // A `done` reached without the key (the root set only after the upgrade): the keys are still due.
    if (step === 'done' && root !== undefined) {
      const key = await tx.query<{ has: boolean }>('select data_key is not null as has from tenants where id = $1', [
        state.defaultTenantId,
      ]);
      if (key.rows[0]?.has !== true) await advance('done', 'keys');
    }
    if (step === 'keys' && root !== undefined) {
      const keys = new TenantKeys(db, environmentKeyRoot(root));
      const dataKey = await keys.dataKey(state.defaultTenantId);
      options.checkpoint?.('made the data key');
      const checkouts = join(tenantRootById(dataDir, state.defaultTenantId), 'checkouts');
      const counts = await rewrap(checkouts, { root, dataKey }, 'forward', {
        ...(options.checkpoint ? { checkpoint: () => options.checkpoint?.('re-wrapped a file') } : {}),
      });
      options.onRewrap?.(counts);
      await advance('keys', 'done');
    }
    return step;
  });
}
