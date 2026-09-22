/**
 * Live frame checking off the calling thread.
 *
 * {@link checkFrame} is synchronous and a contract's `pattern` is untrusted: its own time budget
 * stops a check between messages, but one regex call that runs away cannot be interrupted from the
 * thread it runs on. So the checks run in a `worker_threads` Worker, one frame at a time, each under
 * a hard deadline: a worker that has not answered by then is terminated, the frame is reported
 * `not-checked`, and a fresh worker is started for the next frame. The caller's thread (Electron's
 * main process) never runs a check itself.
 */

import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type { WsFrame, WsFrameContract } from '../ws/model.js';
import type { ChannelMessages } from './frame-check.js';
import type { FrameCheckWorkerData } from './frame-check-worker.js';

/** How long one frame's check may take, worker round trip included, before the worker is replaced. */
export const DEFAULT_FRAME_CHECK_DEADLINE_MS = 1_000;

/** How many frames may wait behind the one being checked before new ones are not checked at all. */
export const DEFAULT_FRAME_CHECK_QUEUE = 1_000;

/** Payload bytes that may wait to be checked; a frame that would pass it is not checked at all. */
export const DEFAULT_FRAME_CHECK_QUEUE_BYTES = 8 * 1024 * 1024;

export interface WorkerFrameCheckerOptions {
  /** Milliseconds one frame's check may take before the worker is terminated and replaced. */
  readonly deadlineMs?: number;
  /** The in-check budget passed to {@link checkFrame}; below the deadline, it ends a slow check cleanly. */
  readonly budgetMs?: number;
  /** Frames that may wait behind the one being checked. */
  readonly maxQueued?: number;
  /** Payload bytes that may wait behind the frame being checked. */
  readonly maxQueuedBytes?: number;
  /** The worker script; tests substitute one. Defaults to the compiled `frame-check-worker.js`. */
  readonly workerUrl?: URL;
}

export interface WorkerFrameChecker {
  /**
   * The frame's contract result. `undefined` for a frame no contract speaks to (binary, control)
   * and for any frame after {@link dispose}. Never rejects.
   */
  check(frame: WsFrame): Promise<WsFrameContract | undefined>;
  /** Terminates the worker; a check still waiting resolves `not-checked`. */
  dispose(): Promise<void>;
  /** Workers started so far (a replaced one counts again). */
  readonly spawned: number;
  /** Whether a worker is currently alive. */
  readonly running: boolean;
}

/**
 * The compiled worker script: the sibling `.js` when running from `dist`, else — running from `src`
 * under vitest — the package's `dist/asyncapi/frame-check-worker.js`, as `xpath/evaluate-async.ts`
 * resolves its own worker.
 */
function defaultWorkerUrl(): URL {
  const sibling = new URL('./frame-check-worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }
  const fallback = import.meta.url.replace(
    /\/src\/asyncapi\/frame-check-worker-host\.ts$/,
    '/dist/asyncapi/frame-check-worker.js',
  );
  /* v8 ignore next 3 -- only reachable when the engine package has never been built */
  if (fallback === import.meta.url) {
    throw new Error('frame-check worker not found: build the engine package first');
  }
  return new URL(fallback);
}

interface Job {
  readonly id: number;
  readonly frame: WsFrame;
  readonly resolve: (contract: WsFrameContract | undefined) => void;
}

const notChecked = (reason: string): WsFrameContract => ({ status: 'not-checked', reason });

export function createWorkerFrameChecker(
  messages: ChannelMessages,
  options: WorkerFrameCheckerOptions = {},
): WorkerFrameChecker {
  const deadlineMs = options.deadlineMs ?? DEFAULT_FRAME_CHECK_DEADLINE_MS;
  const maxQueued = options.maxQueued ?? DEFAULT_FRAME_CHECK_QUEUE;
  const maxQueuedBytes = options.maxQueuedBytes ?? DEFAULT_FRAME_CHECK_QUEUE_BYTES;
  let queuedBytes = 0;
  const data: FrameCheckWorkerData = {
    messages,
    ...(options.budgetMs !== undefined ? { budgetMs: options.budgetMs } : {}),
  };
  let url: URL | undefined = options.workerUrl;
  let worker: Worker | undefined;
  let spawned = 0;
  let disposed = false;
  let nextId = 0;
  let current: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];

  const finish = (contract: WsFrameContract | undefined): void => {
    const job = current;
    if (job === undefined) return;
    current = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    job.resolve(contract);
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
    const next = new Worker(url, { workerData: data });
    spawned += 1;
    // A session's checker must never be what keeps the process alive.
    next.unref();
    next.on('message', (answer: { id: number; contract: WsFrameContract | null }) => {
      if (current?.id === answer.id) finish(answer.contract ?? undefined);
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
    queuedBytes -= job.frame.size;
    current = job;
    try {
      worker ??= spawn();
      worker.postMessage({ id: job.id, frame: job.frame });
    } catch (error) {
      discard();
      finish(notChecked(`the check could not start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    // The deadline starts when this frame reaches the worker, not when it was queued, so one stuck
    // frame never costs the frames behind it their check.
    timer = setTimeout(() => {
      discard();
      finish(notChecked(`the check took longer than ${String(deadlineMs)} ms`));
    }, deadlineMs);
    timer.unref?.();
  }

  return {
    check(frame) {
      if (disposed || frame.opcode !== 'text' || frame.text === undefined) return Promise.resolve(undefined);
      if (queue.length >= maxQueued) return Promise.resolve(notChecked('too many frames waiting to be checked'));
      if (queue.length > 0 && queuedBytes + frame.size > maxQueuedBytes) {
        return Promise.resolve(notChecked('too much data waiting to be checked'));
      }
      return new Promise((resolve) => {
        nextId += 1;
        queue.push({ id: nextId, frame, resolve });
        queuedBytes += frame.size;
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
      queuedBytes = 0;
      current = undefined;
      for (const job of waiting) job.resolve(notChecked('the session ended'));
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
