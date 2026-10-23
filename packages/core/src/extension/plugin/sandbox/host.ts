/**
 * Plugin calls run off the calling thread (phase 7 spec §7, ADR-0031), as scripts do (ADR-0016).
 *
 * One long-lived worker runs calls one at a time, each in a fresh QuickJS runtime. The interpreter's
 * interrupt handler stops a call at its deadline; as a backstop, a worker that has not answered
 * `PLUGIN_LIMITS.backstopMs` after it is terminated and replaced. A `net.fetch` the plugin makes is
 * answered here, through the broker the host gave for that plugin, never inside the worker.
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import { forwardWorkerOutput, workerOutputOptions } from '../../../worker-output.js';
import type { PluginFetch } from './execute.js';
import { PLUGIN_LIMITS, type PluginFetchAsk, type PluginJob, type PluginJobResult } from './model.js';

const WORKER_STACK_MB = 8;
const SPAWN_GRACE_MS = 2_000;

export interface PluginSandboxOptions {
  /**
   * The fetch one call of one plugin uses, asked once per call that may use the network, so each
   * call has its own request budget. Undefined means no network.
   */
  readonly fetchFor?: (pluginId: string) => PluginFetch | undefined;
  /** The worker script; tests substitute one. Defaults to the compiled `worker.js`. */
  readonly workerUrl?: URL;
}

export interface PluginSandbox {
  /** Runs one call. Never rejects: every failure is a result. */
  run(job: PluginJob): Promise<PluginJobResult>;
  dispose(): Promise<void>;
  readonly spawned: number;
}

function defaultWorkerUrl(): URL {
  const sibling = new URL('./worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) return sibling;
  const fallback = import.meta.url.replace(
    /\/src\/extension\/plugin\/sandbox\/host\.ts$/,
    '/dist/extension/plugin/sandbox/worker.js',
  );
  /* v8 ignore next 3 -- only reachable when the core package has never been built */
  if (fallback === import.meta.url) {
    throw new Error('plugin sandbox worker not found: build the core package first');
  }
  return new URL(fallback);
}

interface Pending {
  readonly id: number;
  readonly job: PluginJob;
  readonly resolve: (result: PluginJobResult) => void;
  fetch?: PluginFetch | undefined;
}

const failed = (cause: 'error' | 'timeout', message: string): PluginJobResult => ({
  ok: false,
  cause,
  message,
  log: [],
});

export function createPluginSandbox(options: PluginSandboxOptions = {}): PluginSandbox {
  let url: URL | undefined = options.workerUrl;
  let worker: Worker | undefined;
  let spawned = 0;
  let disposed = false;
  let nextId = 0;
  let current: Pending | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Pending[] = [];

  const finish = (result: PluginJobResult): void => {
    const job = current;
    if (job === undefined) return;
    current = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    job.resolve(result);
    pump();
  };

  const discard = (): void => {
    const dead = worker;
    worker = undefined;
    if (dead !== undefined) {
      dead.removeAllListeners();
      dead.on('error', () => undefined);
      void dead.terminate();
    }
  };

  const answerFetch = (from: Worker, ask: PluginFetchAsk): void => {
    const fetch = current?.id === ask.id ? current.fetch : undefined;
    const reply = (ok: boolean, text: string): void => {
      if (worker === from) from.postMessage({ kind: 'fetched', fetchId: ask.fetchId, ok, text });
    };
    if (fetch === undefined) {
      reply(false, 'This plugin has no network');
      return;
    }
    fetch(ask.request).then(
      (answer) => {
        reply(answer.ok, answer.text);
      },
      (error: unknown) => {
        reply(false, error instanceof Error ? error.message : String(error));
      },
    );
  };

  const spawn = (): Worker => {
    url ??= defaultWorkerUrl();
    const next = new Worker(url, { resourceLimits: { stackSizeMb: WORKER_STACK_MB }, ...workerOutputOptions() });
    forwardWorkerOutput(next);
    spawned += 1;
    next.unref();
    next.on(
      'message',
      (message: PluginFetchAsk | { kind: 'done'; id: number; result: PluginJobResult; recycle: boolean }) => {
        if (message.kind === 'fetch') {
          answerFetch(next, message);
          return;
        }
        if (current?.id !== message.id) return;
        if (message.recycle) discard();
        finish(message.result);
      },
    );
    const broken = (why: string): void => {
      if (worker !== next) return;
      discard();
      finish(failed('error', why));
    };
    next.on('error', (error: unknown) => {
      broken(`The plugin stopped: ${error instanceof Error ? error.message : String(error)}`);
    });
    next.on('exit', () => {
      broken('The plugin stopped unexpectedly');
    });
    return next;
  };

  function pump(): void {
    if (current !== undefined || disposed) return;
    const job = queue.shift();
    if (job === undefined) return;
    current = job;
    job.fetch = job.job.net ? options.fetchFor?.(job.job.pluginId) : undefined;
    const fresh = worker === undefined;
    try {
      worker ??= spawn();
      worker.postMessage({ kind: 'run', id: job.id, job: job.job });
    } catch (error) {
      discard();
      finish(failed('error', `The plugin could not start: ${error instanceof Error ? error.message : String(error)}`));
      return;
    }
    timer = setTimeout(
      () => {
        discard();
        finish(failed('timeout', 'The plugin ran past its time limit'));
      },
      job.job.timeoutMs + PLUGIN_LIMITS.backstopMs + (fresh ? SPAWN_GRACE_MS : 0),
    );
    timer.unref?.();
  }

  return {
    run(job) {
      if (disposed) return Promise.resolve(failed('error', 'The plugin sandbox was stopped'));
      if (queue.length >= PLUGIN_LIMITS.queue) return Promise.resolve(failed('error', 'Too many plugin calls waiting'));
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
      for (const job of waiting) job.resolve(failed('error', 'The plugin sandbox was stopped'));
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
