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

  return new Promise((resolve) => {
    let settled = false;
    const worker = new Worker(workerUrl(), { workerData: { text, kind, expression, options } });

    const finish = (result: QueryResult): void => {
      if (settled) {
        return;
      }
      settled = true;
      clearTimeout(timer);
      worker.removeAllListeners();
      void worker.terminate();
      resolve(result);
    };

    const timer = setTimeout(() => {
      finish({
        kind: 'error',
        code: 'xpath-timeout',
        message: `Query timed out after ${timeoutMs}ms`,
      });
    }, timeoutMs);
    timer.unref?.();

    worker.once('message', (result: QueryResult) => finish(result));
    worker.once('error', (error: unknown) =>
      finish({ kind: 'error', message: error instanceof Error ? error.message : String(error) }),
    );
    worker.once('exit', (code: number) => {
      /* v8 ignore next 3 -- normal completion always finishes via the 'message' listener first */
      if (!settled) {
        finish({ kind: 'error', message: `xpath worker exited unexpectedly (code ${code})` });
      }
    });
  });
}
