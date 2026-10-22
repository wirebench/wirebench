/**
 * What `PART_JSON_SCHEMA` costs a script run (spec §5, decision 6): the startup it adds to every run
 * of a layer that includes it, called or not, and the time of one check of a 1 MiB body against a
 * 50-property schema. Measured in process over `executeJob`, the function the sandbox worker runs.
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import { beforeAll, describe, expect, it } from 'vitest';
import { CI_GATE_FACTOR, SKIP_PERF, median } from '../bench/budgets.js';
import { PART_JSON_SCHEMA } from '#core/script/api/layer-parts';
import { executeJob } from '#core/script/sandbox/execute';
import { SCRIPT_LIMITS, type SandboxJob } from '#core/script/sandbox/model';

const PROPERTIES = 50;
const properties: Record<string, unknown> = {};
for (let i = 0; i < PROPERTIES; i++) {
  properties[`p${String(i)}`] = i % 2 === 0 ? { type: 'integer' } : { type: 'string', minLength: 1 };
}
const SCHEMA = { type: 'object', required: Object.keys(properties), properties };

function body(): string {
  const one: Record<string, unknown> = {};
  const filler = Math.ceil((1024 * 1024) / (PROPERTIES / 2));
  for (let i = 0; i < PROPERTIES; i++) one[`p${String(i)}`] = i % 2 === 0 ? i : 'x'.repeat(filler);
  return JSON.stringify(one);
}

const prelude = (part: string): string =>
  `'use strict';\n(() => {\n${part}\nglobalThis.__finish = () => globalThis.out;\n})();\n`;
const WITH_PART = prelude(`${PART_JSON_SCHEMA}\nglobalThis.jsonSchema = jsonSchema;`);
const WITHOUT_PART = prelude('');

const job = (part: string, code: string, input: unknown = null): SandboxJob => ({
  prelude: part,
  code,
  filename: 'x.post.js',
  input,
  timeoutMs: SCRIPT_LIMITS.defaultTimeoutMs,
});

/** Median wall time of `run`, after one warm-up. */
function timed(run: () => void, samples: number): number {
  run();
  const times: number[] = [];
  for (let i = 0; i < samples; i++) {
    const start = performance.now();
    run();
    times.push(performance.now() - start);
  }
  return median(times);
}

describe.skipIf(SKIP_PERF)('PART_JSON_SCHEMA', () => {
  let module: QuickJSWASMModule;
  beforeAll(async () => {
    module = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
  });

  it('adds under 10 ms to every run that includes it', { retry: 1 }, () => {
    const without = timed(() => executeJob(module, job(WITHOUT_PART, '1')), 31);
    const withPart = timed(() => executeJob(module, job(WITH_PART, '1')), 31);
    const extra = withPart - without;
    console.info(
      `[perf] json-schema-part startup: ${withPart.toFixed(2)} ms with, ${without.toFixed(2)} ms without, +${extra.toFixed(2)} ms (gate ${String(10 * CI_GATE_FACTOR)} ms)`,
    );
    expect(extra).toBeLessThan(10 * CI_GATE_FACTOR);
  });

  it('adds under 1 MiB of memory to every run that includes it', () => {
    const used = (part: string): number => {
      const runtime = module.newRuntime();
      const context = runtime.newContext();
      try {
        const result = context.unwrapResult(context.evalCode(part, 'x.js', { type: 'global', strict: true }));
        result.dispose();
        const memory = runtime.computeMemoryUsage();
        const size = (context.dump(memory) as { memory_used_size: number }).memory_used_size;
        memory.dispose();
        return size;
      } finally {
        context.dispose();
        runtime.dispose();
      }
    };
    const extra = used(WITH_PART) - used(WITHOUT_PART);
    console.info(`[perf] json-schema-part memory: +${(extra / 1024).toFixed(0)} KiB`);
    expect(extra).toBeLessThan(1024 * 1024);
  });

  it('checks a 1 MiB body against a 50-property schema in under 100 ms', { retry: 1 }, () => {
    const input = { body: body(), schema: SCHEMA };
    const parseOnly = 'globalThis.out = JSON.parse(JSON.parse(__host.inputJson).body) && [];';
    const check = 'const i = JSON.parse(__host.inputJson); globalThis.out = jsonSchema(JSON.parse(i.body), i.schema);';
    const parsed = timed(() => executeJob(module, job(WITH_PART, parseOnly, input)), 7);
    const checked = timed(() => {
      const { result } = executeJob(module, job(WITH_PART, check, input));
      expect(result).toMatchObject({ ok: true, output: [] });
    }, 7);
    console.info(
      `[perf] json-schema-part 1 MiB: ${checked.toFixed(1)} ms in all, ${parsed.toFixed(1)} ms of it parsing (gate ${String(100 * CI_GATE_FACTOR)} ms)`,
    );
    expect(checked).toBeLessThan(100 * CI_GATE_FACTOR);
  });
});
