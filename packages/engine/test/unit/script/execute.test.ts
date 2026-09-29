/**
 * `executeJob` in-process, where coverage can see it. The worker-only cases (a runaway recursion,
 * the host's backstop) are in sandbox.test.ts.
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { executeJob } from '../../../src/script/sandbox/execute.js';
import { SCRIPT_LIMITS, type SandboxJob } from '../../../src/script/sandbox/model.js';

let module: QuickJSWASMModule;
beforeAll(async () => {
  module = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
});

const PRELUDE = `
globalThis.log = (...values) => __host.log(values.map(String).join(' '));
globalThis.__finish = () => (globalThis.out === undefined ? null : globalThis.out);
`;

const job = (code: string, extra: Partial<SandboxJob> = {}): SandboxJob => ({
  prelude: PRELUDE,
  code,
  filename: 'x.post.ts',
  input: { n: 2 },
  timeoutMs: 1_000,
  ...extra,
});

describe('executeJob', () => {
  it('runs the prelude, the script and __finish', () => {
    expect(executeJob(module, job('globalThis.out = JSON.parse(__host.inputJson).n * 21; log("ok");'))).toEqual({
      result: { ok: true, output: 42, log: { lines: ['ok'], truncated: false } },
      recycle: false,
    });
  });

  it('hands back no output when __finish returns undefined', () => {
    const outcome = executeJob(module, job('1', { prelude: 'globalThis.__finish = () => undefined;' }));
    expect(outcome.result).toEqual({ ok: true, output: undefined, log: { lines: [], truncated: false } });
  });

  it('interrupts at the deadline and asks for the worker to be replaced', () => {
    const outcome = executeJob(module, job('for (;;) {}', { timeoutMs: 50 }));
    expect(outcome).toMatchObject({ result: { ok: false, error: { code: 'script-timeout' } }, recycle: true });
  });

  it('reports memory exhaustion and asks for the worker to be replaced', () => {
    const outcome = executeJob(
      module,
      job('const a = []; while (true) { a.push("xxxxxxxxxxxxxxxx" + a.length); }', { timeoutMs: 10_000 }),
    );
    expect(outcome).toMatchObject({ result: { ok: false, error: { code: 'script-memory' } }, recycle: true });
  });

  it('keeps the worker after an ordinary error', () => {
    const outcome = executeJob(module, job('throw "plain"'));
    expect(outcome).toMatchObject({
      result: { ok: false, error: { code: 'script-error', message: 'plain' } },
      recycle: false,
    });
  });

  it('reports a failing __finish', () => {
    const outcome = executeJob(
      module,
      job('1', { prelude: 'globalThis.__finish = () => { throw new Error("no"); };' }),
    );
    expect(outcome.result).toMatchObject({ ok: false, error: { code: 'script-error', message: 'Error: no' } });
  });

  it('refuses output past its cap', () => {
    const size = SCRIPT_LIMITS.outputBytes + 16;
    const outcome = executeJob(module, job(`globalThis.out = "z".repeat(${String(size)});`, { timeoutMs: 5_000 }));
    expect(outcome.result).toMatchObject({
      ok: false,
      error: { code: 'script-error', message: 'The script handed back more than its output limit allows' },
    });
  });

  it('refuses host calls with the wrong arguments', () => {
    const outcome = executeJob(
      module,
      job(`
        const refusals = [];
        for (const call of [() => __host.hash('sha256'), () => __host.hmac('sha256', 'k', 'd', 5), () => __host.log(1),
          () => __host.hash('md5', 'x', 'latin1'), () => __host.urlEncode('a b&c'), () => __host.base64url('>>?')]) {
          try { refusals.push(call()); } catch (e) { refusals.push(String(e)); }
        }
        globalThis.out = refusals;
      `),
    );
    expect(outcome.result).toMatchObject({
      ok: true,
      output: [
        'Error: hash: data must be a string',
        'Error: hmac: encoding must be a string',
        'Error: log: a log line must be a string',
        'Error: hash: encoding must be one of hex, base64; got "latin1"',
        'a%20b%26c',
        'Pj4_',
      ],
    });
  });
});
