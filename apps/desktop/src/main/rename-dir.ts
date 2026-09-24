/**
 * Renaming a directory that was just written, retried.
 *
 * On Windows a directory cannot be renamed while anything still holds a handle anywhere
 * inside it, and the app is never the only thing looking: the recursive `fs.watch` the open
 * project keeps, Defender scanning the files the import just wrote, and the search indexer
 * all take transient handles. The rename then fails with `EPERM`/`EBUSY`/`EACCES` for a few
 * tens of milliseconds and succeeds immediately afterwards, so it is retried rather than
 * reported to the user as a failed import. POSIX renames a directory regardless of open
 * handles, so there the first attempt always wins and this is a no-op wrapper.
 */

import { cp, rename, rm } from 'node:fs/promises';

/** Errors that mean "something else has it open right now", not "this can never work". */
const TRANSIENT_CODES = new Set(['EPERM', 'EBUSY', 'EACCES']);

/** How long to keep retrying before giving up and surfacing the error. */
const TOTAL_WAIT_MS = 2_000;

/** How long to wait between attempts. */
const RETRY_DELAY_MS = 50;

/** Options for {@link renameWithRetry}, injected by its tests. */
export interface RenameWithRetryOptions {
  /** Performs one rename attempt; defaults to `fs.promises.rename`. */
  readonly rename?: (from: string, to: string) => Promise<void>;
  /** Waits between attempts; defaults to a real timer. */
  readonly delay?: (ms: number) => Promise<void>;
  readonly totalWaitMs?: number;
  readonly retryDelayMs?: number;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

function codeOf(error: unknown): string | undefined {
  return typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;
}

/**
 * Renames `from` to `to`, retrying while the failure is only that something else holds the
 * directory open. Any other error, and the last transient one once the budget is spent, is
 * rethrown unchanged.
 *
 * @param from the existing path
 * @param to the path it should have
 * @param options injection points for the tests
 */
export async function renameWithRetry(from: string, to: string, options: RenameWithRetryOptions = {}): Promise<void> {
  const attemptRename = options.rename ?? rename;
  const delay = options.delay ?? sleep;
  const retryDelayMs = options.retryDelayMs ?? RETRY_DELAY_MS;
  const attempts = Math.max(1, Math.ceil((options.totalWaitMs ?? TOTAL_WAIT_MS) / retryDelayMs));

  for (let attempt = 1; ; attempt += 1) {
    try {
      await attemptRename(from, to);
      return;
    } catch (error) {
      if (attempt >= attempts || !TRANSIENT_CODES.has(codeOf(error) ?? '')) {
        throw error;
      }
      await delay(retryDelayMs);
    }
  }
}

/**
 * Moves the directory `from` to `to` (which must not exist yet): a {@link renameWithRetry} where
 * both sit on one filesystem, otherwise (`EXDEV` — a staging folder under the OS temp directory,
 * a project on another volume) a recursive copy followed by removing the source. A copy that
 * fails part-way is removed again, so `to` is either complete or absent; removing the source
 * once the copy is complete is best-effort, since the move itself has already succeeded.
 *
 * @param from the existing directory
 * @param to where it should end up
 * @param options injection points for the tests
 */
export async function moveDir(from: string, to: string, options: RenameWithRetryOptions = {}): Promise<void> {
  try {
    await renameWithRetry(from, to, options);
    return;
  } catch (error) {
    if (codeOf(error) !== 'EXDEV') {
      throw error;
    }
  }
  try {
    await cp(from, to, { recursive: true, errorOnExist: true, force: false });
  } catch (error) {
    await rm(to, { recursive: true, force: true }).catch(() => undefined);
    throw error;
  }
  await rm(from, { recursive: true, force: true }).catch(() => undefined);
}
