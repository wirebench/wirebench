/**
 * The self-hosted migration's second forward step (hosted edition spec §19.10), driven by
 * `server_identity.tenancy_step`, which `0020` sets to `files` on every installation, fresh or upgraded:
 *
 * - **`files`**: rename `repos/` and `checkouts/` into the default tenant's root; move the `tmp/removed-…`
 *   repositories (deleted workspaces, kept on purpose) into its `tmp/` and delete the rest of the old `tmp/`,
 *   scratch that is rebuilt as needed; check the users' state files for the old absolute prefix; then `keys`.
 * - **`keys`**: the data key and the re-wrap (§19.7) are plan Task 24's. Until then the step has nothing to do
 *   and goes straight on to `done`.
 *
 * Every part resumes. A rename is due when its source is present and its destination absent, and done in the
 * reverse case; both present is `tenancy-move-conflict`, refused before anything moves. The steps run inside one
 * transaction holding an advisory lock, so two processes starting at once never move the same directory, and a
 * crash leaves `tenancy_step` where it was, for the next start-up to finish.
 */
import { lstat, mkdir, readdir, readFile, realpath, rename, rm } from 'node:fs/promises';
import { join, relative, resolve, sep } from 'node:path';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../db/querier.js';
import { TENANTS_DIR, tenantRootById } from './paths.js';

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
/** A state file larger than this is not one the host writes; the scan names it rather than reading it all. */
const MAX_STATE_FILE_BYTES = 8 * 1024 * 1024;
/** `pg_advisory_xact_lock`'s key for the step: one process at a time moves the data directory. */
const STEP_LOCK = "hashtext('wirebench-tenancy-file-step')";

/** A test seam: called after each part of the step has happened, so a test can stop the step there. */
export type StepCheckpoint = (part: string) => void;

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

async function present(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (error) {
    if (isMissing(error)) return false;
    throw error;
  }
}

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

const conflict = (paths: readonly (readonly [string, string])[]): WirebenchError =>
  new WirebenchError(
    'tenancy-move-conflict',
    `both the old and the new location exist: ${paths.map(([from, to]) => `${from} and ${to}`).join('; ')}. ` +
      'Keep the one that holds the data, move the other away, and start again',
  );

/**
 * The `files` part. Refuses with `tenancy-move-conflict` before anything moves, and with `tenancy-prefix-found`
 * after the moves (which then stand, and are done on the next attempt) when a state file names the old prefix.
 */
export async function moveFiles(dataDir: string, defaultTenantId: string, checkpoint: StepCheckpoint = () => {}) {
  const base = resolve(dataDir);
  const root = tenantRootById(base, defaultTenantId);
  const renames: (readonly [string, string])[] = [];
  const conflicts: (readonly [string, string])[] = [];
  for (const name of MOVED_DIRS) {
    const from = join(base, name);
    const to = join(root, name);
    const [source, destination] = [await present(from), await present(to)];
    if (source && destination) conflicts.push([from, to]);
    else if (source) renames.push([from, to]);
  }
  const oldTmp = join(base, OLD_TMP_DIR);
  const kept = (await present(oldTmp)) ? (await readdir(oldTmp)).filter((name) => REMOVED.test(name)) : [];
  for (const name of kept) {
    const to = join(root, 'tmp', name);
    if (await present(to)) conflicts.push([join(oldTmp, name), to]);
  }
  if (conflicts.length > 0) throw conflict(conflicts);

  await mkdir(root, { recursive: true });
  for (const [from, to] of renames) {
    await rename(from, to);
    checkpoint(`renamed ${relative(base, from)}`);
  }
  if (kept.length > 0) await mkdir(join(root, 'tmp'), { recursive: true });
  for (const name of kept) {
    await rename(join(oldTmp, name), join(root, 'tmp', name));
    checkpoint(`kept ${name}`);
  }
  await rm(oldTmp, { recursive: true, force: true });
  checkpoint('removed tmp');

  const found = await oldPrefixFiles(base, join(root, 'checkouts'));
  if (found.length > 0) {
    throw new WirebenchError(
      'tenancy-prefix-found',
      `these state files name the old checkouts directory, which has moved: ${found.join(', ')}`,
    );
  }
  checkpoint('scanned');
}

/**
 * The users' state files under `checkouts` that hold the old absolute prefix `<dataDir>/checkouts/`, as paths
 * relative to `checkouts`. The workspaces' own content (`tree/` and `server/base/`) is the users' data, not state,
 * and is not read. A server host cannot create a linked project, but a file that holds one would break later.
 */
export async function oldPrefixFiles(dataDir: string, checkouts: string): Promise<string[]> {
  const base = resolve(dataDir);
  const prefixes = [...new Set([base, await realpath(base).catch(() => base)])].map((dir) =>
    join(dir, MOVED_DIRS[1], ''),
  );
  // Both separators: a file may spell the path either way on Windows.
  const needles = [...new Set(prefixes.flatMap((p) => [p, p.split(sep).join('/')]))];
  const found: string[] = [];
  // checkouts/<user>/workspaces/<id>/tree and …/<id>/server/base: the workspace's files.
  const isContent = (parts: readonly string[]): boolean =>
    parts[1] === 'workspaces' &&
    ((parts.length === 4 && parts[3] === 'tree') ||
      (parts.length === 5 && parts[3] === 'server' && parts[4] === 'base'));
  const walk = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if (isMissing(error)) return;
      throw error;
    }
    for (const entry of entries) {
      const path = join(dir, entry.name);
      const parts = relative(checkouts, path).split(sep);
      if (entry.isDirectory()) {
        if (!isContent(parts)) await walk(path);
      } else if (entry.isFile()) {
        const info = await lstat(path);
        const text = info.size > MAX_STATE_FILE_BYTES ? undefined : await readFile(path, 'utf8');
        if (text === undefined || needles.some((needle) => text.includes(needle))) found.push(parts.join('/'));
      }
    }
  };
  await walk(checkouts);
  return found.sort();
}

export interface RunStepsOptions {
  readonly checkpoint?: StepCheckpoint;
}

/**
 * Runs whatever of the forward steps is due and returns the step it ends at, or `undefined` on a database before
 * `0020`. A step of a revert refuses with `tenancy-reverting`: a forward start-up never runs during one.
 */
export async function runTenancySteps(
  db: Database,
  dataDir: string,
  options: RunStepsOptions = {},
): Promise<TenancyStep | undefined> {
  return db.transaction(async (tx) => {
    await tx.query(`select pg_advisory_xact_lock(${STEP_LOCK})`);
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
      await moveFiles(dataDir, state.defaultTenantId, options.checkpoint);
      await advance('files', 'keys');
    }
    if (step === 'keys') {
      // Plan Task 24: the default tenant's data key and the re-wrap go here, before `done`.
      await advance('keys', 'done');
    }
    return step;
  });
}
