/**
 * Time-bounded wrapper around {@link evaluate}: runs the (synchronous, potentially pathological)
 * XPath/XQuery evaluation inside a `node:worker_threads` Worker so a runaway expression
 * (`1 to 100000000`, an infinite FLWOR, …) cannot freeze the Electron main process. Callers get
 * a `{kind: 'error', code: 'xpath-timeout'}` result instead of a hang once `timeoutMs` elapses.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { EvaluateOptions, QueryResult } from './evaluate.js';
import type { RegexWorkerResult } from './worker.js';
import { forwardWorkerOutput, workerOutputOptions } from '../worker-output.js';

/** Default time budget for one evaluation, matching the brief's 5s ceiling for the scratchpad. */
const DEFAULT_TIMEOUT_MS = 5_000;

/** Options accepted by {@link evaluateWithTimeout}. */
export interface EvaluateWithTimeoutOptions {
  /** Milliseconds to wait before terminating the worker and reporting `xpath-timeout`. */
  readonly timeoutMs?: number;
  /**
   * Which document `text` is. Defaults to `xml`.
   *
   * The timeout, the worker and the result shape are identical either way — only the evaluator on
   * the far side differs — so a JSON query gets the same runaway-expression protection for free.
   */
  readonly kind?: 'xml' | 'json';
}

/**
 * Resolves the compiled worker entry point.
 *
 * `worker.ts` must run as plain JavaScript in a Worker (no TS loader is an approved dependency
 * here — `tsx` is only ever an optional peer of `vite`, not installed). `tsc -b` (run by
 * `pnpm typecheck`, which `pnpm check` and `pnpm build` both depend on) always emits
 * `dist/xpath/worker.js` alongside this file's own compiled output, so the common case is just
 * "the sibling `worker.js` next to wherever this module itself is running from". The only time
 * that sibling doesn't exist is running this module directly from `src` (e.g.
 * `vitest run packages/engine/test/unit/xpath` on its own, before a build) — in that case fall
 * back to the package's `dist/xpath/worker.js`, computed from this file's own `src/xpath/…`
 * location.
 */
function workerUrl(): URL {
  const sibling = new URL('./worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }
  const fallback = import.meta.url.replace(/\/src\/xpath\/evaluate-async\.ts$/, '/dist/xpath/worker.js');
  /* v8 ignore next 3 -- only reachable when the engine package has genuinely never been built */
  if (fallback === import.meta.url) {
    throw new Error('xpath worker not found: build the engine package (pnpm --filter @wirebench/engine build) first');
  }
  return new URL(fallback);
}

/**
 * Evaluates `expression` against `xml` on a worker thread, resolving to the same
 * {@link QueryResult} shape {@link evaluate} returns synchronously, but bounded by `timeoutMs`
 * (default 5000ms). Never throws or rejects: a timeout, a worker crash, or an evaluation error
 * are all reported as `{kind: 'error'}`.
 *
 * @param xml the document to query
 * @param expression the XPath or XQuery source
 * @param options language and namespace bindings, forwarded to `evaluate`
 * @param timeoutOptions `{timeoutMs}`, default 5000
 */
export function evaluateWithTimeout(
  text: string,
  expression: string,
  options: EvaluateOptions,
  timeoutOptions?: EvaluateWithTimeoutOptions,
): Promise<QueryResult> {
  const timeoutMs = timeoutOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  const kind = timeoutOptions?.kind ?? 'xml';
  return runOnWorker<QueryResult>({ job: 'query', text, kind, expression, options }, timeoutMs, (failure) =>
    failure.kind === 'timeout'
      ? { kind: 'error', code: 'xpath-timeout', message: `Query timed out after ${timeoutMs}ms` }
      : { kind: 'error', message: failure.message },
  );
}

/** The outcome of {@link matchRegexWithTimeout}. */
export type RegexMatchResult =
  | { readonly kind: 'matched'; readonly matched: boolean }
  | { readonly kind: 'error'; readonly code: 'regex-timeout' | 'regex-invalid'; readonly message: string };

/**
 * Tests `pattern` against `text` on the same worker thread and time budget as
 * {@link evaluateWithTimeout}.
 *
 * A pattern can come from a file someone else wrote (a request's or a sequence's `matches:`), and a
 * backtracking pattern such as `(a+)+$` against a long near-miss runs for minutes. JavaScript cannot
 * interrupt a running `RegExp`, so the only bound is a thread that can be terminated. Never throws
 * or rejects: an invalid pattern, a timeout and a worker crash are all `{kind: 'error'}`.
 */
export function matchRegexWithTimeout(
  pattern: string,
  text: string,
  timeoutOptions?: Pick<EvaluateWithTimeoutOptions, 'timeoutMs'>,
): Promise<RegexMatchResult> {
  const timeoutMs = timeoutOptions?.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  return runOnWorker<RegexWorkerResult, RegexMatchResult>(
    { job: 'regex', pattern, text },
    timeoutMs,
    (failure) =>
      failure.kind === 'timeout'
        ? { kind: 'error', code: 'regex-timeout', message: `Regular expression timed out after ${timeoutMs}ms` }
        : { kind: 'error', code: 'regex-invalid', message: failure.message },
    (posted) =>
      'error' in posted
        ? { kind: 'error', code: 'regex-invalid', message: posted.error }
        : { kind: 'matched', matched: posted.matched },
  );
}

/** Why a worker produced no result of its own. */
type WorkerFailure = { readonly kind: 'timeout' } | { readonly kind: 'crash'; readonly message: string };

/**
 * Runs one job on a fresh worker, terminating it after `timeoutMs`. `onFailure` shapes a timeout or
 * crash into the caller's result type; `map` shapes what the worker posted (identity by default).
 */
function runOnWorker<Posted, Result = Posted>(
  workerData: unknown,
  timeoutMs: number,
  onFailure: (failure: WorkerFailure) => Result,
  map: (posted: Posted) => Result = (posted) => posted as unknown as Result,
): Promise<Result> {
  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(workerUrl(), { workerData, ...workerOutputOptions() });
    forwardWorkerOutput(worker);

    const finish = (result: Result): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => finish(onFailure({ kind: 'timeout' })), timeoutMs);
    timer.unref?.();

    worker.once('message', (posted: Posted) => finish(map(posted)));
    worker.once('error', (error: unknown) =>
      finish(onFailure({ kind: 'crash', message: error instanceof Error ? error.message : String(error) })),
    );
    worker.once('exit', (code: number) => {
      /* v8 ignore next 3 -- normal completion always finishes via the 'message' listener first */
      if (!settled) {
        finish(onFailure({ kind: 'crash', message: `xpath worker exited unexpectedly (code ${code})` }));
      }
    });
  });
}
