/**
 * Runs one {@link PluginJob} in a fresh QuickJS runtime (phase 7 spec §7, ADR-0031).
 *
 * The runtime gets the job's memory and stack limits and an interrupt handler with its deadline; its
 * module loader refuses every import. The context holds the ECMAScript library and two host
 * functions of strings: `__log`, and `__fetch` only when the job may use the network. `__fetch`
 * returns a QuickJS promise the host settles when the brokered request ends; the host runs the
 * runtime's pending jobs until the call's own promise settles. The plugin's module is evaluated, the
 * named contribution's method is called with the job's arguments and a frozen context, and its result
 * comes back as JSON text. Everything is disposed before this returns.
 */
import type { QuickJSContext, QuickJSDeferredPromise, QuickJSWASMModule } from 'quickjs-emscripten-core';
import { toSandboxError } from '../../../script/sandbox/execute.js';
import { LogCollector } from '../../../script/sandbox/host-api.js';
import { PLUGIN_LIMITS, type PluginFailureCause, type PluginJob, type PluginJobResult } from './model.js';

/** The host side of `net.fetch`: the request as JSON text in, the answer out. */
export type PluginFetch = (request: string) => Promise<{ readonly ok: boolean; readonly text: string }>;

export interface PluginExecuteOutcome {
  readonly result: PluginJobResult;
  /** True after a timeout, memory exhaustion or a failed dispose: the host replaces the worker. */
  readonly recycle: boolean;
}

const MODULE_FILE = 'main.js';

/** The call, as code: finds the contribution, builds its context, awaits it, hands back JSON text. */
function callSource(job: PluginJob): string {
  const point = JSON.stringify(job.point);
  const id = JSON.stringify(job.contribution);
  const method = JSON.stringify(job.method);
  return `(async () => {
  const point = __ns[${point}];
  const entry = point !== null && typeof point === 'object' ? point[${id}] : undefined;
  if (entry === null || typeof entry !== 'object' || typeof entry[${method}] !== 'function') {
    throw new Error('main.js exports no ' + ${point} + '[' + ${id} + '].' + ${method});
  }
  const context = { log: (message) => { __log(String(message)); } };
  if (typeof __fetch === 'function') {
    const fetch = __fetch;
    context.net = Object.freeze({
      fetch: async (request) => {
        const answer = JSON.parse(await fetch(JSON.stringify(request)));
        if (!answer.ok) throw new Error(answer.text);
        return JSON.parse(answer.text);
      },
    });
  }
  Object.freeze(context);
  const value = await entry[${method}](...JSON.parse(__args), context);
  return JSON.stringify(value === undefined ? null : value);
})()`;
}

function failure(cause: PluginFailureCause, message: string, log: LogCollector): PluginJobResult {
  return { ok: false, cause, message, log: log.result().lines };
}

function causeOf(error: unknown, interrupted: boolean): { cause: PluginFailureCause; message: string } {
  const mapped = toSandboxError(error, MODULE_FILE, interrupted);
  if (mapped.code === 'script-timeout') return { cause: 'timeout', message: 'The plugin ran past its time limit' };
  if (mapped.code === 'script-memory') return { cause: 'memory', message: 'The plugin ran out of memory' };
  return { cause: 'error', message: mapped.message };
}

export async function executePluginJob(
  module: QuickJSWASMModule,
  job: PluginJob,
  fetch: PluginFetch | undefined,
): Promise<PluginExecuteOutcome> {
  const log = new LogCollector();
  const deadline = Date.now() + job.timeoutMs;
  let interrupted = false;
  const runtime = module.newRuntime();
  runtime.setMemoryLimit(PLUGIN_LIMITS.memoryBytes);
  runtime.setMaxStackSize(PLUGIN_LIMITS.stackBytes);
  runtime.setInterruptHandler(() => {
    interrupted ||= Date.now() > deadline;
    return interrupted;
  });
  runtime.setModuleLoader((name) => ({ error: new Error(`A plugin cannot import "${name}"`) }));
  const context = runtime.newContext();
  const waiting = new Set<Promise<void>>();
  const deferreds = new Set<QuickJSDeferredPromise>();
  let recycle = false;
  const failed = (error: unknown): PluginExecuteOutcome => {
    const { cause, message } = causeOf(error, interrupted);
    recycle ||= cause !== 'error';
    return { result: failure(cause, message, log), recycle };
  };
  try {
    installHost(context, job, fetch, log, waiting, deferreds);
    const evaluated = context.evalCode(job.code, MODULE_FILE, { type: 'module', strict: true });
    if (evaluated.error !== undefined) {
      const error: unknown = context.dump(evaluated.error);
      evaluated.error.dispose();
      return failed(error);
    }
    context.setProp(context.global, '__ns', evaluated.value);
    evaluated.value.dispose();
    const args = context.newString(JSON.stringify(job.args));
    context.setProp(context.global, '__args', args);
    args.dispose();
    const called = context.evalCode(callSource(job), '<call>', { strict: true });
    if (called.error !== undefined) {
      const error: unknown = context.dump(called.error);
      called.error.dispose();
      return failed(error);
    }
    const promise = called.value;
    try {
      for (;;) {
        const jobs = runtime.executePendingJobs();
        if (jobs.error !== undefined) {
          const error: unknown = context.dump(jobs.error);
          jobs.error.dispose();
          return failed(error);
        }
        const state = context.getPromiseState(promise);
        if (state.type === 'fulfilled') {
          const text: unknown = context.dump(state.value);
          state.value.dispose();
          if (typeof text !== 'string' || Buffer.byteLength(text, 'utf8') > PLUGIN_LIMITS.ioBytes) {
            return { result: failure('error', 'The plugin returned too much, or nothing JSON can hold', log), recycle };
          }
          return { result: { ok: true, value: JSON.parse(text) as unknown, log: log.result().lines }, recycle };
        }
        if (state.type === 'rejected') {
          const error: unknown = context.dump(state.error);
          state.error.dispose();
          return failed(error);
        }
        if (waiting.size === 0) {
          return { result: failure('error', 'The plugin waited on something that never settles', log), recycle };
        }
        const left = deadline - Date.now();
        if (left <= 0) {
          recycle = true;
          return { result: failure('timeout', 'The plugin ran past its time limit', log), recycle };
        }
        let timer: ReturnType<typeof setTimeout> | undefined;
        await Promise.race([
          ...waiting,
          new Promise<void>((resolve) => {
            timer = setTimeout(resolve, left);
          }),
        ]);
        if (timer !== undefined) clearTimeout(timer);
      }
    } finally {
      promise.dispose();
    }
  } finally {
    for (const deferred of deferreds) if (deferred.alive) deferred.dispose();
    try {
      context.dispose();
      runtime.dispose();
    } catch {
      recycle = true;
    }
  }
}

function installHost(
  context: QuickJSContext,
  job: PluginJob,
  fetch: PluginFetch | undefined,
  log: LogCollector,
  waiting: Set<Promise<void>>,
  deferreds: Set<QuickJSDeferredPromise>,
): void {
  const logFn = context.newFunction('__log', (handle) => {
    const line: unknown = context.dump(handle);
    log.add(String(line).slice(0, PLUGIN_LIMITS.logLineBytes));
  });
  context.setProp(context.global, '__log', logFn);
  logFn.dispose();
  if (!job.net || fetch === undefined) return;
  const fetchFn = context.newFunction('__fetch', (handle) => {
    const request: unknown = context.dump(handle);
    const deferred = context.newPromise();
    deferreds.add(deferred);
    const settle = async (): Promise<void> => {
      const answer =
        typeof request === 'string'
          ? await fetch(request).catch((error: unknown) => ({
              ok: false,
              text: error instanceof Error ? error.message : String(error),
            }))
          : { ok: false, text: 'net.fetch takes a request object' };
      if (!context.alive || !deferred.alive) return;
      const text = context.newString(JSON.stringify(answer));
      deferred.resolve(text);
      text.dispose();
    };
    const work = settle().finally(() => {
      waiting.delete(work);
    });
    waiting.add(work);
    return deferred.handle;
  });
  context.setProp(context.global, '__fetch', fetchFn);
  fetchFn.dispose();
}
