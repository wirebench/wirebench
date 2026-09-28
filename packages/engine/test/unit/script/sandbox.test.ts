/**
 * The script sandbox (ADR-0016): a fresh QuickJS runtime per job, on a worker, with nothing of the
 * host reachable but `__host`'s functions of strings, and hard time, memory and stack limits.
 */
import { createHmac } from 'node:crypto';
import { afterAll, describe, expect, it } from 'vitest';
import { clampTimeout, createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { positionIn, toSandboxError } from '../../../src/script/sandbox/execute.js';
import { SCRIPT_LIMITS, type SandboxJob } from '../../../src/script/sandbox/model.js';

/** A minimal API: `log`, and `out` handed back by `__finish`. */
const PRELUDE = `
globalThis.log = (...values) => __host.log(values.map(String).join(' '));
globalThis.input = JSON.parse(__host.inputJson);
globalThis.__finish = () => ({ out: globalThis.out === undefined ? null : globalThis.out });
`;

const job = (code: string, extra: Partial<SandboxJob> = {}): SandboxJob => ({
  prelude: PRELUDE,
  code,
  filename: 'test.pre.ts',
  input: null,
  timeoutMs: 1_000,
  ...extra,
});

const sandbox = createScriptSandbox();
afterAll(async () => {
  await sandbox.dispose();
});

describe('createScriptSandbox', () => {
  it('runs a script and hands back what __finish returns, with its log', async () => {
    const result = await sandbox.run(job('log("hello", 1); globalThis.out = input.a + 1;', { input: { a: 41 } }));
    expect(result).toEqual({ ok: true, output: { out: 42 }, log: { lines: ['hello 1'], truncated: false } });
  });

  it('stops an endless loop at its deadline, and the next job runs', async () => {
    const started = Date.now();
    const result = await sandbox.run(job('while (true) {}', { timeoutMs: 200 }));
    expect(result).toMatchObject({ ok: false, error: { code: 'script-timeout' } });
    expect(Date.now() - started).toBeLessThan(200 + SCRIPT_LIMITS.backstopMs);
    expect(await sandbox.run(job('globalThis.out = "after"'))).toMatchObject({ ok: true, output: { out: 'after' } });
  });

  it('stops a script that exhausts memory', { timeout: 20_000 }, async () => {
    const result = await sandbox.run(
      job('const a = []; while (true) { a.push("xxxxxxxxxxxxxxxx" + a.length); }', { timeoutMs: 10_000 }),
    );
    expect(result).toMatchObject({ ok: false, error: { code: 'script-memory' } });
    expect(await sandbox.run(job('globalThis.out = 1'))).toMatchObject({ ok: true });
  });

  it('stops a runaway recursion as a script error, not a crash', async () => {
    const result = await sandbox.run(job('function f() { return f(); }\nf();'));
    expect(result).toMatchObject({ ok: false, error: { code: 'script-error' } });
    expect(result.ok ? '' : result.error.message).toMatch(/stack overflow/);
  });

  it('reaches nothing of the host', async () => {
    const probes = [
      'typeof process',
      'typeof require',
      'typeof fetch',
      'typeof setTimeout',
      'typeof setInterval',
      'typeof queueMicrotask === "function" ? "fn" : "undefined"',
      'typeof Buffer',
      'typeof WebAssembly',
      'typeof XMLHttpRequest',
      'typeof std',
      'typeof os',
    ];
    const result = await sandbox.run(job(`globalThis.out = [${probes.join(', ')}];`));
    expect(result).toMatchObject({ ok: true });
    const out = result.ok ? (result.output as { out: string[] }).out : [];
    expect(out.slice(0, 5)).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
    expect(out.slice(6)).toEqual(['undefined', 'undefined', 'undefined', 'undefined', 'undefined']);
  });

  it('gives Function and eval nothing beyond the sandbox', async () => {
    const result = await sandbox.run(
      job(`
        const viaConstructor = (function () {}).constructor('return typeof process')();
        const viaEval = (0, eval)('typeof require');
        let viaImport = 'no error';
        try { new Function('return import("fs")')(); } catch (e) { viaImport = 'threw'; }
        globalThis.out = [viaConstructor, viaEval, viaImport];
      `),
    );
    expect(result).toMatchObject({ ok: true });
    const [viaConstructor, viaEval] = result.ok ? (result.output as { out: string[] }).out : [];
    expect(viaConstructor).toBe('undefined');
    expect(viaEval).toBe('undefined');
  });

  it('keeps nothing from one job for the next', async () => {
    await sandbox.run(job('globalThis.leftOver = "x"; Object.prototype.polluted = 1;'));
    const result = await sandbox.run(job('globalThis.out = [typeof leftOver, ({}).polluted === undefined];'));
    expect(result).toMatchObject({ ok: true, output: { out: ['undefined', true] } });
  });

  it('reports a thrown error with its position in the script', async () => {
    const result = await sandbox.run(job('const a = 1;\nconst b = 2;\n  throw new TypeError("nope");'));
    expect(result).toEqual({
      ok: false,
      error: { code: 'script-error', message: 'TypeError: nope', position: { line: 3, column: 22 } },
      log: { lines: [], truncated: false },
      output: { out: null },
    });
  });

  it('reports a syntax error with its position', async () => {
    const result = await sandbox.run(job('const a = 1;\nconst = 2;'));
    expect(result).toMatchObject({ ok: false, error: { code: 'script-error', position: { line: 2 } } });
  });

  it('keeps what a failing script recorded before it threw', async () => {
    const result = await sandbox.run(job('globalThis.out = "partial"; throw new Error("late");'));
    expect(result).toMatchObject({ ok: false, error: { code: 'script-error' }, output: { out: 'partial' } });
  });

  it('cuts a log off at its caps', async () => {
    const lines = await sandbox.run(job(`for (let i = 0; i < ${String(SCRIPT_LIMITS.logLines + 50)}; i++) log(i);`));
    expect(lines.log.lines).toHaveLength(SCRIPT_LIMITS.logLines);
    expect(lines.log.truncated).toBe(true);
    const bytes = await sandbox.run(job(`log("y".repeat(${String(SCRIPT_LIMITS.logBytes + 10)})); log("dropped");`));
    expect(bytes.log.lines).toHaveLength(1);
    expect(bytes.log.lines[0]).toMatch(/log cut short\)$/);
    expect(bytes.log.truncated).toBe(true);
  });

  it('computes hashes and HMACs on the host, and refuses an unknown algorithm', async () => {
    const result = await sandbox.run(
      job(`
        let refused = '';
        try { __host.hash('sha3', 'x'); } catch (e) { refused = String(e); }
        globalThis.out = [__host.hmac('sha256', 'k', 'd'), __host.hash('sha1', 'abc', 'base64'), refused,
          __host.base64('hé'), __host.fromBase64(__host.base64('hé')), __host.uuid().length];
      `),
    );
    expect(result).toMatchObject({ ok: true });
    const out = result.ok ? (result.output as { out: unknown[] }).out : [];
    expect(out[0]).toBe(createHmac('sha256', 'k').update('d').digest('hex'));
    expect(out[1]).toBe('qZk+NkcGgWq6PiVxeFDCbJzQ2J0=');
    expect(out[2]).toMatch(/hash: algorithm must be one of/);
    expect(out.slice(3)).toEqual(['aMOp', 'hé', 36]);
  });

  it('refuses a host call with a non-string argument', async () => {
    const result = await sandbox.run(job('__host.base64({ toString() { return "x"; } });'));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'script-error', message: expect.stringMatching(/base64: text must be a string/) as unknown },
    });
  });

  it('reports a prelude failure as the API failing to start', async () => {
    const result = await sandbox.run(job('1', { prelude: 'throw new Error("broken prelude")' }));
    expect(result).toMatchObject({
      ok: false,
      error: { code: 'script-error', message: 'The script API failed to start: Error: broken prelude' },
    });
  });

  it('refuses jobs past its queue, and after dispose', async () => {
    const local = createScriptSandbox();
    const results = await Promise.all(Array.from({ length: 20 }, () => local.run(job('globalThis.out = 1'))));
    expect(results.filter((r) => !r.ok)).toHaveLength(3);
    await local.dispose();
    expect(await local.run(job('1'))).toMatchObject({
      ok: false,
      error: { message: 'The script sandbox was stopped' },
    });
  });
});

describe('sandbox helpers', () => {
  it('clamps a timeout to the allowed range', () => {
    expect(clampTimeout(undefined)).toBe(SCRIPT_LIMITS.defaultTimeoutMs);
    expect(clampTimeout(-5)).toBe(SCRIPT_LIMITS.defaultTimeoutMs);
    expect(clampTimeout(Number.NaN)).toBe(SCRIPT_LIMITS.defaultTimeoutMs);
    expect(clampTimeout(60_000)).toBe(SCRIPT_LIMITS.maxTimeoutMs);
    expect(clampTimeout(250.7)).toBe(250);
  });

  it('finds a position only in the script file', () => {
    expect(positionIn('    at f (a.ts:4:2)\n    at <eval> (b.ts:9:1)', 'b.ts')).toEqual({ line: 9, column: 1 });
    expect(positionIn('    at <prelude>:1:1', 'b.ts')).toBeUndefined();
  });

  it('describes thrown values that are not errors', () => {
    expect(toSandboxError('plain', 'x.ts', false)).toEqual({ code: 'script-error', message: 'plain' });
    expect(toSandboxError({ a: 1 }, 'x.ts', false)).toEqual({ code: 'script-error', message: '{"a":1}' });
    expect(toSandboxError(undefined, 'x.ts', true)).toMatchObject({ code: 'script-timeout' });
  });
});
