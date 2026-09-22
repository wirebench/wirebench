/**
 * REST response checking off the calling thread.
 *
 * {@link checkRestResponse} is synchronous and a contract's `pattern` is untrusted: its own time
 * budget stops a check between steps, but one regex call that runs away cannot be interrupted from
 * the thread it runs on. So the checks run in a `worker_threads` Worker, one response at a time,
 * each under a hard deadline: a worker that has not answered by then is terminated, the response is
 * reported `not-checked`, and a fresh worker is started for the next one. The caller's thread
 * (Electron's main process) never runs a check itself.
 *
 * The input is posted, not serialised: an OpenAPI schema may be shared or refer to itself, which
 * structured clone carries and JSON cannot. Callers pass only the matched operation's `responses`,
 * so each send copies that much and no more.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { RestContractInput, RestContractResult } from './contract-check.js';

/** How long one response's check may take, worker round trip included, before the worker is replaced. */
export const DEFAULT_REST_CHECK_DEADLINE_MS = 1_000;

/** How many responses may wait behind the one being checked before new ones are not checked at all. */
export const DEFAULT_REST_CHECK_QUEUE = 16;

export interface RestContractCheckerOptions {
  /** Milliseconds one response's check may take before the worker is terminated and replaced. */
  readonly deadlineMs?: number;
  /** The worker script; tests substitute one. Defaults to the compiled `contract-check-worker.js`. */
  readonly workerUrl?: URL;
}

export interface RestContractChecker {
  /** The response's contract result; `not-checked` on overrun, overflow, failure or after dispose. Never rejects. */
  check(input: RestContractInput): Promise<RestContractResult>;
  /** Terminates the worker; checks still waiting resolve `not-checked`. */
  dispose(): Promise<void>;
  /** Workers started so far (a replaced one counts again). */
  readonly spawned: number;
  /** Whether a worker is currently alive. */
  readonly running: boolean;
}

/**
 * The compiled worker script: the sibling `.js` when running from `dist`, else — running from `src`
 * under vitest — the package's `dist/rest/contract-check-worker.js`.
 */
function defaultWorkerUrl(): URL {
  const sibling = new URL('./contract-check-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }
  const fallback = import.meta.url.replace(
    /\/src\/rest\/contract-check-worker-host\.ts$/,
    '/dist/rest/contract-check-worker.js',
  );
  /* v8 ignore next 3 -- only reachable when the engine package has never been built */
  if (fallback === import.meta.url) {
    throw new Error('contract-check worker not found: build the engine package first');
  }
  return new URL(fallback);
}

interface Job {
  readonly id: number;
  readonly input: RestContractInput;
  readonly resolve: (result: RestContractResult) => void;
}

const notChecked = (reason: string): RestContractResult => ({ status: 'not-checked', problems: [], notes: [reason] });

export function createRestContractChecker(options: RestContractCheckerOptions = {}): RestContractChecker {
  const deadlineMs = options.deadlineMs ?? DEFAULT_REST_CHECK_DEADLINE_MS;
  let url: URL | undefined = options.workerUrl;
  let worker: Worker | undefined;
  let spawned = 0;
  let disposed = false;
  let nextId = 0;
  let current: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];

  const finish = (result: RestContractResult): void => {
    const job = current;
    if (job === undefined) return;
    current = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    job.resolve(result);
    pump();
  };

  /** Drops the current worker without waiting for it; its late answer or exit is then ignored. */
  const discard = (): void => {
    const dead = worker;
    worker = undefined;
    if (dead !== undefined) {
      dead.removeAllListeners();
      // An 'error' after the listeners are gone would otherwise be an uncaught exception.
      dead.on('error', () => undefined);
      void dead.terminate();
    }
  };

  const spawn = (): Worker => {
    url ??= defaultWorkerUrl();
    const next = new Worker(url);
    spawned += 1;
    // The checker must never be what keeps the process alive.
    next.unref();
    next.on('message', (answer: { id: number; result: RestContractResult }) => {
      if (current?.id === answer.id) finish(answer.result);
    });
    const failed = (why: string): void => {
      if (worker !== next) return;
      discard();
      finish(notChecked(why));
    };
    next.on('error', (error: unknown) => {
      failed(`the check failed: ${error instanceof Error ? error.message : String(error)}`);
    });
    next.on('exit', () => {
      failed('the check stopped unexpectedly');
    });
    return next;
  };

  function pump(): void {
    if (current !== undefined || disposed) return;
    const job = queue.shift();
    if (job === undefined) return;
    current = job;
    try {
      worker ??= spawn();
      worker.postMessage({ id: job.id, input: job.input });
    } catch (error) {
      discard();
      finish(notChecked(`the check could not start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // The deadline starts when this response reaches the worker, not when it was queued, so one
    // stuck check never costs the ones behind it their own.
    timer = setTimeout(() => {
      discard();
      finish(notChecked(`the check took longer than ${String(deadlineMs)} ms`));
    }, deadlineMs);
    timer.unref?.();
  }

  return {
    check(input) {
      if (disposed) return Promise.resolve(notChecked('the checker was stopped'));
      if (queue.length >= DEFAULT_REST_CHECK_QUEUE) {
        return Promise.resolve(notChecked('too many responses waiting to be checked'));
      }
      return new Promise((resolve) => {
        nextId += 1;
        queue.push({ id: nextId, input, resolve });
        pump();
      });
    },
    async dispose() {
      if (disposed) return;
      disposed = true;
      const dead = worker;
      worker = undefined;
      if (timer !== undefined) clearTimeout(timer);
      timer = undefined;
      const waiting = [...(current !== undefined ? [current] : []), ...queue.splice(0)];
      current = undefined;
      for (const job of waiting) job.resolve(notChecked('the checker was stopped'));
      if (dead !== undefined) {
        dead.removeAllListeners();
        dead.on('error', () => undefined);
        await dead.terminate();
      }
    },
    get spawned() {
      return spawned;
    },
    get running() {
      return worker !== undefined;
    },
  };
}
