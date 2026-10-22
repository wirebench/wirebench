/**
 * Where the engine's worker threads send their stdout.
 *
 * By default Node pipes a worker's stdout into the process's own. A host whose stdout carries a
 * protocol (the CLI's stdio MCP server) calls `routeWorkerOutput` with the stream that may take a
 * stray line instead, and every worker started afterwards has its stdout forwarded there. Without
 * a sink nothing changes: the desktop keeps Node's default.
 */
import type { Writable } from 'node:stream';
import type { Worker } from 'node:worker_threads';

let sink: Writable | undefined;

/** Routes the stdout of workers started from now on to `to`. Returns the restore. */
export function routeWorkerOutput(to: Writable): () => void {
  const previous = sink;
  sink = to;
  return () => {
    sink = previous;
  };
}

/** The `Worker` options that make its stdout readable here, when a sink is set. Spread into the constructor's. */
export function workerOutputOptions(): { stdout?: true } {
  return sink === undefined ? {} : { stdout: true };
}

/** Forwards `worker`'s stdout to the sink, when one was set at its creation. Call right after `new Worker`. */
export function forwardWorkerOutput(worker: Worker): void {
  if (sink !== undefined) {
    worker.stdout.pipe(sink, { end: false });
  }
}
