/**
 * Entry point run inside a `node:worker_threads` Worker by {@link evaluateWithTimeout}. Receives
 * `{xml, expression, options}` as `workerData`, runs the synchronous {@link evaluate} once, and
 * posts the {@link QueryResult} back — this file never imports anything Electron/DOM-specific,
 * only what `evaluate` itself needs, so it can run unmodified in a bare worker thread.
 */

import { parentPort, workerData } from 'node:worker_threads';
import { evaluate } from './evaluate.js';
import type { EvaluateOptions, QueryResult } from './evaluate.js';

/** The shape `evaluateWithTimeout` passes as `workerData` when spawning this worker. */
interface WorkerRequest {
  readonly xml: string;
  readonly expression: string;
  readonly options: EvaluateOptions;
}

/* v8 ignore start -- exercised only inside a real worker thread; covered by evaluate-async.test.ts
   end-to-end (a query actually running to completion, or timing out), not by unit-level coverage
   instrumentation, which does not attach across the thread boundary. */
if (parentPort !== null) {
  const request = workerData as WorkerRequest;
  let result: QueryResult;
  try {
    result = evaluate(request.xml, request.expression, request.options);
  } catch (error) {
    result = { kind: 'error', message: error instanceof Error ? error.message : String(error) };
  }
  parentPort.postMessage(result);
}
/* v8 ignore stop */
