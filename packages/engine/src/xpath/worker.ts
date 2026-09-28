/**
 * Entry point run inside a `node:worker_threads` Worker by {@link evaluateWithTimeout} and
 * {@link matchRegexWithTimeout}. Receives either a query (`{text, kind, expression, options}`) or a
 * regular-expression job (`{job: 'regex', pattern, text}`) as `workerData`, runs it once, and posts
 * the result back — this file never imports anything Electron/DOM-specific, only what the
 * evaluators themselves need, so it can run unmodified in a bare worker thread.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { evaluate, evaluateJson } from './evaluate.js';
import type { EvaluateOptions, QueryResult } from './evaluate.js';

/** The shape `evaluateWithTimeout` passes as `workerData` when spawning this worker. */
interface QueryRequest {
  readonly job?: 'query';
  readonly text: string;
  /** Which evaluator to run. Absent for a caller that predates JSON querying, meaning `xml`. */
  readonly kind?: 'xml' | 'json';
  readonly expression: string;
  readonly options: EvaluateOptions;
}

/** The shape `matchRegexWithTimeout` passes: a pattern compiled and tested here, off the caller's thread. */
interface RegexRequest {
  readonly job: 'regex';
  readonly pattern: string;
  readonly text: string;
}

/** What a regex job posts back: whether it matched, or why the pattern could not be compiled. */
export type RegexWorkerResult = { readonly matched: boolean } | { readonly error: string };

/* v8 ignore start -- exercised only inside a real worker thread; covered by evaluate-async.test.ts
   end-to-end (a query actually running to completion, or timing out), not by unit-level coverage
   instrumentation, which does not attach across the thread boundary. */
function runRegex(request: RegexRequest): RegexWorkerResult {
  try {
    return { matched: new RegExp(request.pattern).test(request.text) };
  } catch (error) {
    return { error: error instanceof Error ? error.message : String(error) };
  }
}

function runQuery(request: QueryRequest): QueryResult {
  let result: QueryResult;
  try {
    result =
      request.kind === 'json'
        ? evaluateJson(request.text, request.expression, request.options)
        : evaluate(request.text, request.expression, request.options);
  } catch (error) {
    result = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  return result;
}

if (parentPort !== null) {
  const request = workerData as QueryRequest | RegexRequest;
  if (request.job === 'regex') {
    parentPort.postMessage(runRegex(request));
  } else {
    parentPort.postMessage(runQuery(request));
  }
}
/* v8 ignore stop */
