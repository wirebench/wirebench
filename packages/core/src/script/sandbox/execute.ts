/**
 * Runs one {@link SandboxJob} in a fresh QuickJS runtime (ADR-0016).
 *
 * The runtime gets a memory limit, a stack limit and an interrupt handler with the job's deadline,
 * and a context holding nothing but the ECMAScript library and `__host`, an object of plain
 * functions of strings. The prelude builds the script's API from those, the script runs, and
 * `__finish()` hands back the result as JSON text. Every handle is disposed before this returns, and
 * the runtime with it: nothing a script did survives into the next job.
 *
 * This runs inside the sandbox worker (`worker.ts`). Its stack must be larger than the QuickJS stack
 * limit, or a deep recursion overflows the host's stack before QuickJS's own check trips; the host
 * starts the worker with room to spare.
 */
import type { QuickJSContext, QuickJSHandle, QuickJSWASMModule, VmCallResult } from 'quickjs-emscripten-core';
import {
  base64,
  base64url,
  fromBase64,
  hash,
  hmac,
  HostCallError,
  LogCollector,
  urlEncode,
  uuid,
  xpathStrings,
} from './host-api.js';
import { SCRIPT_LIMITS, type SandboxError, type SandboxJob, type SandboxResult, type ScriptPosition } from './model.js';

/** What the worker hands back: the result, and whether the runtime ended in a state worth not reusing the worker after. */
export interface ExecuteOutcome {
  readonly result: SandboxResult;
  /** True after a timeout, memory exhaustion or a failed dispose: the host replaces the worker. */
  readonly recycle: boolean;
}

const PRELUDE_FILE = '<prelude>';
const FINISH_FILE = '<finish>';

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

/** The first `file:line:column` of the script's own file in a QuickJS stack. */
export function positionIn(stack: string, filename: string): ScriptPosition | undefined {
  const match = new RegExp(`${escapeRegExp(filename)}:(\\d+):(\\d+)`).exec(stack);
  if (match === null) {
    return undefined;
  }
  return { line: Number(match[1]), column: Number(match[2]) };
}

interface DumpedError {
  readonly name?: unknown;
  readonly message?: unknown;
  readonly stack?: unknown;
}

function describe(value: unknown): { text: string; name?: string; stack: string } {
  if (typeof value === 'object' && value !== null) {
    const error = value as DumpedError;
    const name = typeof error.name === 'string' ? error.name : undefined;
    const message = typeof error.message === 'string' ? error.message : undefined;
    const stack = typeof error.stack === 'string' ? error.stack : '';
    if (message !== undefined) {
      return {
        text: name !== undefined ? `${name}: ${message}` : message,
        ...(name !== undefined ? { name } : {}),
        stack,
      };
    }
  }
  if (typeof value === 'string') {
    return { text: value, stack: '' };
  }
  let text: string;
  try {
    text = JSON.stringify(value) ?? String(value);
  } catch {
    text = String(value);
  }
  return { text, stack: '' };
}

/** Maps what the script threw to the sandbox's error codes. */
export function toSandboxError(value: unknown, filename: string, interrupted: boolean): SandboxError {
  const { text, name, stack } = describe(value);
  if (interrupted || (name === 'InternalError' && text.endsWith('interrupted'))) {
    return { code: 'script-timeout', message: 'The script ran past its time limit' };
  }
  if (name === 'InternalError' && text.endsWith('out of memory')) {
    return { code: 'script-memory', message: 'The script ran out of memory' };
  }
  const position = positionIn(stack, filename);
  return { code: 'script-error', message: text, ...(position !== undefined ? { position } : {}) };
}

/** A host function's argument as a string; anything else is refused with a message the script sees. */
function stringArg(context: QuickJSContext, handle: QuickJSHandle | undefined, what: string): string {
  const value: unknown = handle === undefined ? undefined : context.dump(handle);
  if (typeof value !== 'string') {
    throw new HostCallError(`${what} must be a string`);
  }
  return value;
}

function optionalStringArg(
  context: QuickJSContext,
  handle: QuickJSHandle | undefined,
  what: string,
): string | undefined {
  const value: unknown = handle === undefined ? undefined : context.dump(handle);
  if (value === undefined) {
    return undefined;
  }
  if (typeof value !== 'string') {
    throw new HostCallError(`${what} must be a string`);
  }
  return value;
}

type HostFunction = (context: QuickJSContext, args: QuickJSHandle[]) => QuickJSHandle | undefined;

/** Installs `__host`: plain functions of strings, and nothing else of the host. */
function installHost(context: QuickJSContext, log: LogCollector, inputJson: string): void {
  const functions: Record<string, HostFunction> = {
    log: (ctx, args) => {
      log.add(stringArg(ctx, args[0], 'a log line'));
      return undefined;
    },
    hash: (ctx, args) =>
      ctx.newString(
        hash(
          stringArg(ctx, args[0], 'algorithm'),
          stringArg(ctx, args[1], 'data'),
          optionalStringArg(ctx, args[2], 'encoding'),
        ),
      ),
    hmac: (ctx, args) =>
      ctx.newString(
        hmac(
          stringArg(ctx, args[0], 'algorithm'),
          stringArg(ctx, args[1], 'key'),
          stringArg(ctx, args[2], 'data'),
          optionalStringArg(ctx, args[3], 'encoding'),
        ),
      ),
    uuid: (ctx) => ctx.newString(uuid()),
    base64: (ctx, args) => ctx.newString(base64(stringArg(ctx, args[0], 'text'))),
    fromBase64: (ctx, args) => ctx.newString(fromBase64(stringArg(ctx, args[0], 'text'))),
    base64url: (ctx, args) => ctx.newString(base64url(stringArg(ctx, args[0], 'text'))),
    urlEncode: (ctx, args) => ctx.newString(urlEncode(stringArg(ctx, args[0], 'text'))),
    xpath: (ctx, args) =>
      ctx.newString(
        xpathStrings(
          stringArg(ctx, args[0], 'xml'),
          stringArg(ctx, args[1], 'expression'),
          stringArg(ctx, args[2], 'namespaces'),
        ),
      ),
  };
  const host = context.newObject();
  try {
    for (const [name, implementation] of Object.entries(functions)) {
      const fn = context.newFunction(name, (...args): VmCallResult<QuickJSHandle> | QuickJSHandle | undefined => {
        try {
          return implementation(context, args);
        } catch (error) {
          const message = error instanceof HostCallError ? error.message : 'the host function failed';
          return { error: context.newError(`${name}: ${message}`) };
        }
      });
      context.setProp(host, name, fn);
      fn.dispose();
    }
    const input = context.newString(inputJson);
    context.setProp(host, 'inputJson', input);
    input.dispose();
    context.setProp(context.global, '__host', host);
  } finally {
    host.dispose();
  }
}

/** Evaluates code and returns its value dumped to plain data, or what it threw. */
function evaluate(
  context: QuickJSContext,
  code: string,
  filename: string,
): { ok: true; value: unknown } | { ok: false; thrown: unknown } {
  const result = context.evalCode(code, filename, { type: 'global', strict: true, backtraceBarrier: true });
  if ('error' in result && result.error !== undefined) {
    const thrown: unknown = context.dump(result.error);
    result.error.dispose();
    return { ok: false, thrown };
  }
  const value: unknown = context.dump(result.value);
  result.value.dispose();
  return { ok: true, value };
}

/** `__finish()`'s JSON, parsed; refused when it is not text or is past the output cap. */
function finish(context: QuickJSContext): { ok: true; output: unknown } | { ok: false; error: SandboxError } {
  const done = evaluate(context, 'JSON.stringify(__finish())', FINISH_FILE);
  if (!done.ok) {
    return { ok: false, error: toSandboxError(done.thrown, FINISH_FILE, false) };
  }
  if (typeof done.value !== 'string') {
    return { ok: true, output: undefined };
  }
  if (Buffer.byteLength(done.value, 'utf8') > SCRIPT_LIMITS.outputBytes) {
    return {
      ok: false,
      error: { code: 'script-error', message: 'The script handed back more than its output limit allows' },
    };
  }
  return { ok: true, output: JSON.parse(done.value) as unknown };
}

export function executeJob(module: QuickJSWASMModule, job: SandboxJob): ExecuteOutcome {
  const log = new LogCollector();
  const runtime = module.newRuntime();
  let interrupted = false;
  let recycle = false;
  const deadline = Date.now() + job.timeoutMs;
  runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes);
  runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
  runtime.setInterruptHandler(() => {
    if (Date.now() > deadline) {
      interrupted = true;
    }
    return interrupted;
  });
  const context = runtime.newContext();
  let result: SandboxResult;
  try {
    installHost(context, log, JSON.stringify(job.input ?? null));
    const prelude = evaluate(context, job.prelude, PRELUDE_FILE);
    if (!prelude.ok) {
      const error = toSandboxError(prelude.thrown, PRELUDE_FILE, interrupted);
      result = {
        ok: false,
        error:
          error.code === 'script-error'
            ? { code: 'script-error', message: `The script API failed to start: ${error.message}` }
            : error,
        log: log.result(),
      };
    } else {
      const ran = evaluate(context, job.code, job.filename);
      if (ran.ok) {
        const done = finish(context);
        result = done.ok
          ? { ok: true, output: done.output, log: log.result() }
          : { ok: false, error: done.error, log: log.result() };
      } else {
        const error = toSandboxError(ran.thrown, job.filename, interrupted);
        // A script that threw may still have recorded tests before it did; keep them. A script that
        // ran out of time or memory gets nothing more run on its behalf.
        const done = error.code === 'script-error' ? finish(context) : undefined;
        result = {
          ok: false,
          error,
          log: log.result(),
          ...(done?.ok === true ? { output: done.output } : {}),
        };
      }
    }
  } catch (error) {
    // The host itself failed (for instance the WASM heap was exhausted outside the runtime's limit).
    recycle = true;
    result = {
      ok: false,
      error: { code: 'script-error', message: error instanceof Error ? error.message : String(error) },
      log: log.result(),
    };
  }
  if (!result.ok && result.error.code !== 'script-error') {
    recycle = true;
  }
  try {
    context.dispose();
    runtime.dispose();
  } catch {
    recycle = true;
  }
  return { result, recycle };
}
