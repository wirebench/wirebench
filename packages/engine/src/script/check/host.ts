/**
 * Script type-checking and editor help off the calling thread (spec §Type-checking).
 *
 * The TypeScript language service is heavy, so it runs on one long-lived worker, one request at a
 * time, each with a deadline. A worker that overruns is terminated and replaced, and the request
 * fails. Every request that concerns a model carries the model, so a replaced worker loses nothing:
 * the next request rebuilds it. The pattern is the sandbox host's (`../sandbox/host.ts`).
 */
import { existsSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { Worker } from 'node:worker_threads';
import type {
  ScriptCompletion,
  ScriptDiagnostic,
  ScriptModel,
  ScriptQuickInfo,
  ScriptSignatureHelp,
} from './service.js';

export type {
  ScriptCompletion,
  ScriptDiagnostic,
  ScriptModel,
  ScriptQuickInfo,
  ScriptSignatureHelp,
} from './service.js';

/** One request to the checker worker. */
export type CheckerRequest =
  | { readonly op: 'check'; readonly model: ScriptModel }
  | { readonly op: 'remove'; readonly modelId: string }
  | { readonly op: 'diagnostics'; readonly modelId: string; readonly model: ScriptModel }
  | {
      readonly op: 'completions' | 'quickInfo' | 'signatureHelp';
      readonly modelId: string;
      readonly model: ScriptModel;
      readonly line: number;
      readonly column: number;
    };

/** How long one request may take, a fresh worker's start-up included. */
export const CHECK_DEADLINE_MS = 20_000;
const QUEUE_LIMIT = 64;

export interface ScriptCheckerOptions {
  readonly deadlineMs?: number;
  readonly workerUrl?: URL;
}

export interface ScriptChecker {
  /** Checks a script once, keeping no model. */
  check(model: ScriptModel): Promise<readonly ScriptDiagnostic[]>;
  diagnostics(modelId: string, model: ScriptModel): Promise<readonly ScriptDiagnostic[]>;
  completions(modelId: string, model: ScriptModel, line: number, column: number): Promise<readonly ScriptCompletion[]>;
  quickInfo(modelId: string, model: ScriptModel, line: number, column: number): Promise<ScriptQuickInfo | undefined>;
  signatureHelp(
    modelId: string,
    model: ScriptModel,
    line: number,
    column: number,
  ): Promise<ScriptSignatureHelp | undefined>;
  /** Drops a model the editor closed. */
  remove(modelId: string): Promise<void>;
  dispose(): Promise<void>;
}

/** Thrown by a checker request that could not be answered (overrun, a stopped checker, a crash). */
export class ScriptCheckerError extends Error {}

function defaultWorkerUrl(): URL {
  const sibling = new URL('./worker.js', import.meta.url);
  if (existsSync(fileURLToPath(sibling))) {
    return sibling;
  }
  const fallback = import.meta.url.replace(/\/src\/script\/check\/host\.ts$/, '/dist/script/check/worker.js');
  /* v8 ignore next 3 -- only reachable when the engine package has never been built */
  if (fallback === import.meta.url) {
    throw new Error('script checker worker not found: build the engine package first');
  }
  return new URL(fallback);
}

interface Job {
  readonly id: number;
  readonly request: CheckerRequest;
  readonly resolve: (value: unknown) => void;
  readonly reject: (error: Error) => void;
}

export function createScriptChecker(options: ScriptCheckerOptions = {}): ScriptChecker {
  const deadlineMs = options.deadlineMs ?? CHECK_DEADLINE_MS;
  let url = options.workerUrl;
  let worker: Worker | undefined;
  let disposed = false;
  let nextId = 0;
  let current: Job | undefined;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const queue: Job[] = [];

  const settle = (outcome: { result: unknown } | { error: string }): void => {
    const job = current;
    if (job === undefined) return;
    current = undefined;
    if (timer !== undefined) clearTimeout(timer);
    timer = undefined;
    if ('error' in outcome) job.reject(new ScriptCheckerError(outcome.error));
    else job.resolve(outcome.result);
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

  const spawn = (): Worker => {
    url ??= defaultWorkerUrl();
    const next = new Worker(url);
    next.unref();
    next.on('message', (answer: { id: number; result?: unknown; error?: string }) => {
      if (current?.id !== answer.id) return;
      settle(answer.error !== undefined ? { error: answer.error } : { result: answer.result });
    });
    const broken = (why: string): void => {
      if (worker !== next) return;
      discard();
      settle({ error: why });
    };
    next.on('error', (error: unknown) =>
      broken(`The checker stopped: ${error instanceof Error ? error.message : String(error)}`),
    );
    next.on('exit', () => broken('The checker stopped unexpectedly'));
    return next;
  };

  function pump(): void {
    if (current !== undefined || disposed) return;
    const job = queue.shift();
    if (job === undefined) return;
    current = job;
    try {
      worker ??= spawn();
      worker.postMessage({ id: job.id, request: job.request });
    } catch (error) {
      discard();
      settle({ error: `The checker could not start: ${error instanceof Error ? error.message : String(error)}` });
      return;
    }
    timer = setTimeout(() => {
      discard();
      settle({ error: `The check took longer than ${String(deadlineMs)} ms` });
    }, deadlineMs);
    timer.unref?.();
  }

  const send = <T>(request: CheckerRequest): Promise<T> => {
    if (disposed) return Promise.reject(new ScriptCheckerError('The checker was stopped'));
    if (queue.length >= QUEUE_LIMIT) return Promise.reject(new ScriptCheckerError('Too many checks waiting'));
    return new Promise<T>((resolve, reject) => {
      nextId += 1;
      queue.push({ id: nextId, request, resolve: resolve as (value: unknown) => void, reject });
      pump();
    });
  };

  return {
    check: (model) => send({ op: 'check', model }),
    diagnostics: (modelId, model) => send({ op: 'diagnostics', modelId, model }),
    completions: (modelId, model, line, column) => send({ op: 'completions', modelId, model, line, column }),
    quickInfo: async (modelId, model, line, column) =>
      (await send<ScriptQuickInfo | null>({ op: 'quickInfo', modelId, model, line, column })) ?? undefined,
    signatureHelp: async (modelId, model, line, column) =>
      (await send<ScriptSignatureHelp | null>({ op: 'signatureHelp', modelId, model, line, column })) ?? undefined,
    remove: async (modelId) => {
      await send({ op: 'remove', modelId });
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
      for (const job of waiting) job.reject(new ScriptCheckerError('The checker was stopped'));
      if (dead !== undefined) {
        dead.removeAllListeners();
        dead.on('error', () => undefined);
        await dead.terminate();
      }
    },
  };
}
