/**
 * Renaming a directory, retried while something else holds it open (hosted edition spec §19.10's file step).
 *
 * On Windows a directory cannot be renamed while anything holds a handle inside it, and Defender and the search
 * indexer take transient ones on a tree that was just written: the rename fails with `EPERM`, `EBUSY` or `EACCES`
 * for a few tens of milliseconds, then succeeds. POSIX renames regardless, so there the first attempt wins.
 *
 * The same rule as `packages/host/src/rename-dir.ts`'s `renameWithRetry`, kept here because the server cannot import
 * host source: `@wirebench/host` is source-only and outside this package's `rootDir` (ADR-0033).
 */
import { rename } from 'node:fs/promises';

const TRANSIENT_CODES: ReadonlySet<string> = new Set(['EPERM', 'EBUSY', 'EACCES']);
const TOTAL_WAIT_MS = 2_000;
const RETRY_DELAY_MS = 50;

export interface RenameWithRetryOptions {
  readonly rename?: (from: string, to: string) => Promise<void>;
  readonly delay?: (ms: number) => Promise<void>;
  readonly totalWaitMs?: number;
  readonly retryDelayMs?: number;
}

const sleep = (ms: number): Promise<void> =>
  new Promise((resolve) => {
    setTimeout(resolve, ms);
  });

const codeOf = (error: unknown): string | undefined =>
  typeof error === 'object' && error !== null && 'code' in error ? String(error.code) : undefined;

/** Renames `from` to `to`, retrying a transient failure for about two seconds; any other error is rethrown. */
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
      if (attempt >= attempts || !TRANSIENT_CODES.has(codeOf(error) ?? '')) throw error;
      await delay(retryDelayMs);
    }
  }
}
