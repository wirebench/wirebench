/**
 * Script runs off the calling thread (ADR-0016).
 *
 * One long-lived worker runs scripts one at a time, each in a fresh QuickJS runtime with its own
 * time, memory and stack limits. The interpreter's interrupt handler is what normally stops a
 * script at its deadline; as a backstop, a worker that has not answered `SCRIPT_LIMITS.backstopMs`
 * after the deadline is terminated and replaced, and the job ends as `script-timeout`. A worker
 * whose job ran out of time or memory is replaced too, so no runtime state outlives a bad job.
 *
 * The pattern is `rest/contract-check-worker-host.ts`'s. The worker gets an explicit stack size:
 * QuickJS's own stack check must trip before the host thread's stack runs out.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { SCRIPT_LIMITS, type SandboxJob, type SandboxResult } from './model.js';

/** How many jobs may wait behind the one running before new ones are refused. */
export const SCRIPT_QUEUE_LIMIT = 16;

/** The worker's stack, in MB: comfortably above the QuickJS stack limit. */
const WORKER_STACK_MB = 8;

/** Extra backstop time for the first job on a new worker, which loads the WebAssembly module first. */
const SPAWN_GRACE_MS = 2_000;

export interface ScriptSandboxOptions {
  /** The worker script; tests substitute one. Defaults to the compiled `worker.js`. */
  readonly workerUrl?: URL;
}

export interface ScriptSandbox {
  /** Runs one job. Never rejects: every failure is a result. */
  run(job: SandboxJob): Promise<SandboxResult>;
  /** Terminates the worker; jobs still waiting resolve as failed. */
  dispose(): Promise<void>;
  /** Workers started so far (a replaced one counts again). */
  readonly spawned: number;
}

/**
 * The compiled worker script: the sibling `.js` when running from `dist`, else — running from `src`
 * under vitest — the package's `dist/script/sandbox/worker.js`.
 */
function defaultWorkerUrl(): URL {
  const sibling = new URL('./worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }
  const fallback = import.meta.url.replace(/\/src\/script\/sandbox\/host\.ts$/, '/dist/script/sandbox/worker.js');
  /* v8 ignore next 3 -- only reachable when the engine package has never been built */
  if (fallback === import.meta.url) {
    throw new Error('script sandbox worker not found: build the engine package first');
  }
  return new URL(fallback);
}

interface Job {
  readonly id: number;
  readonly job: SandboxJob;
  readonly resolve: (result: SandboxResult) => void;
}

const EMPTY_LOG = { lines: [], truncated: false } as const;

const failed = (code: 'script-error' | 'script-timeout', message: string): SandboxResult => ({
  ok: false,
  error: { code, message },
  log: EMPTY_LOG,
});

/** A job's time limit, clamped to what a request file may ask for. */
export function clampTimeout(timeoutMs: number | undefined): number {
  if (timeoutMs === undefined || !Number.isFinite(timeoutMs) || timeoutMs <= 0) {
    return SCRIPT_LIMITS.defaultTimeoutMs;
  }
  return Math.min(Math.floor(timeoutMs), SCRIPT_LIMITS.maxTimeoutMs);
}

export function createScriptSandbox(options: ScriptSandboxOptions = {}): ScriptSandbox {
  let url: URL | undefined = options.workerUrl;
  let worker: Worker | undefined;
  let spawned = 0;
  let disposed = false;
  let nextId = 0;
  let current: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];

  const finish = (result: SandboxResult): void => {
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
    const next = new Worker(url, { resourceLimits: { stackSizeMb: WORKER_STACK_MB } });
    spawned += 1;
    // The sandbox must never be what keeps the process alive.
    next.unref();
    next.on('message', (answer: { id: number; result: SandboxResult; recycle: boolean }) => {
      if (current?.id !== answer.id) return;
      if (answer.recycle) discard();
      finish(answer.result);
    });
    const broken = (why: string): void => {
      if (worker !== next) return;
      discard();
      finish(failed('script-error', why));
    };
    next.on('error', (error: unknown) => {
      broken(`The script stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
    next.on('exit', () => {
      broken('The script stopped unexpectedly');
    });
    return next;
  };

  function pump(): void {
    if (current !== undefined || disposed) return;
    const job = queue.shift();
    if (job === undefined) return;
    current = job;
    const timeoutMs = clampTimeout(job.job.timeoutMs);
    const fresh = worker === undefined;
    try {
      worker ??= spawn();
      worker.postMessage({ id: job.id, job: { ...job.job, timeoutMs } });
    } catch (error) {
      discard();
      finish(
        failed('script-error', `The script could not start: ${error instanceof Error ? error.message : String(error)}`),
      );
      return;
    }
    // The deadline starts when the job reaches the worker, so one stuck script never costs the ones
    // behind it their own time.
    timer = setTimeout(
      () => {
        discard();
        finish(failed('script-timeout', 'The script ran past its time limit'));
      },
      timeoutMs + SCRIPT_LIMITS.backstopMs + (fresh ? SPAWN_GRACE_MS : 0),
    );
    timer.unref?.();
  }

  return {
    run(job) {
      if (disposed) return Promise.resolve(failed('script-error', 'The script sandbox was stopped'));
      if (queue.length >= SCRIPT_QUEUE_LIMIT) {
        return Promise.resolve(failed('script-error', 'Too many scripts waiting to run'));
      }
      return new Promise((resolve) => {
        nextId += 1;
        queue.push({ id: nextId, job, resolve });
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
      for (const job of waiting) job.resolve(failed('script-error', 'The script sandbox was stopped'));
      if (dead !== undefined) {
        dead.removeAllListeners();
        dead.on('error', () => undefined);
        await dead.terminate();
      }
    },
    get spawned() {
      return spawned;
    },
  };
}
