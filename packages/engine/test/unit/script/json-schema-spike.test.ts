/**
 * `.jsonSchema` in the script sandbox (spec §5, decision 6): `PART_JSON_SCHEMA` runs the engine's own
 * JSON Schema validator, the one the response assertions use, inside QuickJS under the real limits.
 *
 * The body is one 50-property object of 1 MiB, as in the contract check's perf test: an array of
 * small rows would hit the validator's node cap and measure the cap, not the check. The per-run
 * startup cost the part adds is gated in `test/perf/json-schema-part.perf.test.ts`.
 */
import { newQuickJSWASMModuleFromVariant, type QuickJSWASMModule } from 'quickjs-emscripten-core';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { validateJsonSchema } from '../../../src/json/schema-validate.js';
import { PART_JSON_SCHEMA } from '../../../src/script/api/layer-parts.js';
import { createScriptSandbox } from '../../../src/script/sandbox/host.js';
import { SCRIPT_LIMITS } from '../../../src/script/sandbox/model.js';

const PROPERTIES = 50;
const BODY_BYTES = 1024 * 1024;

const properties: Record<string, unknown> = {};
for (let i = 0; i < PROPERTIES; i++) {
  properties[`p${String(i)}`] = i % 2 === 0 ? { type: 'integer' } : { type: 'string', minLength: 1 };
}
const SCHEMA = { type: 'object', required: Object.keys(properties), properties };

/** One object matching `SCHEMA`, of at least 1 MiB as JSON: the string properties carry the bulk. */
function matchingBody(): Record<string, unknown> {
  const one: Record<string, unknown> = {};
  const filler = Math.ceil(BODY_BYTES / (PROPERTIES / 2));
  for (let i = 0; i < PROPERTIES; i++) one[`p${String(i)}`] = i % 2 === 0 ? i : 'x'.repeat(filler);
  return one;
}

/** The part, exposed as a global, and a `__finish` that hands back what the script left in `out`. */
const PRELUDE = `'use strict';
(() => {
${PART_JSON_SCHEMA}
globalThis.jsonSchema = jsonSchema;
globalThis.__finish = () => globalThis.out;
})();
`;

/** What a post-response script does: parse the response body, then check it. */
const SCRIPT = `
const input = JSON.parse(__host.inputJson);
globalThis.out = jsonSchema(JSON.parse(input.body), input.schema);
`;

describe('PART_JSON_SCHEMA in the sandbox', () => {
  const sandbox = createScriptSandbox();
  let module: QuickJSWASMModule;
  beforeAll(async () => {
    module = await newQuickJSWASMModuleFromVariant(import('@jitl/quickjs-wasmfile-release-sync'));
  });
  afterAll(async () => {
    await sandbox.dispose();
  });

  it('checks a 1 MiB body against a 50-property schema within the default time and memory limits', async () => {
    const body = JSON.stringify(matchingBody());
    expect(body.length).toBeGreaterThanOrEqual(BODY_BYTES);
    const result = await sandbox.run({
      prelude: PRELUDE,
      code: SCRIPT,
      filename: 'Rows.post.js',
      input: { body, schema: SCHEMA },
      timeoutMs: SCRIPT_LIMITS.defaultTimeoutMs,
    });
    expect(result).toMatchObject({ ok: true, output: [] });
  });

  it('finds the problems the host validator finds', async () => {
    const broken: Record<string, unknown> = { ...matchingBody(), p0: 'zero', p1: '', extra: true };
    delete broken.p2;
    const result = await sandbox.run({
      prelude: PRELUDE,
      code: SCRIPT,
      filename: 'Rows.post.js',
      input: { body: JSON.stringify(broken), schema: SCHEMA },
      timeoutMs: SCRIPT_LIMITS.defaultTimeoutMs,
    });
    const expected = validateJsonSchema(broken, SCHEMA);
    expect(expected.map((p) => p.keyword).sort()).toEqual(['minLength', 'required', 'type']);
    expect(result).toMatchObject({ ok: true, output: expected });
  });

  it('fits in half the memory limit, with the body and its parse still held', () => {
    const runtime = module.newRuntime();
    runtime.setMemoryLimit(SCRIPT_LIMITS.memoryBytes / 2);
    runtime.setMaxStackSize(SCRIPT_LIMITS.stackBytes);
    const context = runtime.newContext();
    try {
      const host = context.newObject();
      const inputJson = context.newString(JSON.stringify({ body: JSON.stringify(matchingBody()), schema: SCHEMA }));
      context.setProp(host, 'inputJson', inputJson);
      context.setProp(context.global, '__host', host);
      inputJson.dispose();
      host.dispose();
      const holding = `
const input = JSON.parse(__host.inputJson);
globalThis.parsed = JSON.parse(input.body);
globalThis.problems = JSON.stringify(jsonSchema(parsed, input.schema));
`;
      for (const code of [PRELUDE, holding]) {
        const result = context.evalCode(code, 'x.js', { type: 'global', strict: true });
        const error = 'error' in result ? result.error : undefined;
        expect(error === undefined ? undefined : context.dump(error)).toBeUndefined();
        if ('value' in result) result.value.dispose();
        error?.dispose();
      }
      const usage = context.getProp(context.global, 'problems');
      expect(context.dump(usage)).toBe('[]');
      usage.dispose();
      const memory = runtime.computeMemoryUsage();
      const used = (context.dump(memory) as { memory_used_size: number }).memory_used_size;
      memory.dispose();
      console.info(`[spike] jsonSchema over a 1 MiB body: ${(used / 1024 / 1024).toFixed(1)} MiB in use`);
      expect(used).toBeLessThan(SCRIPT_LIMITS.memoryBytes / 2);
    } finally {
      context.dispose();
      runtime.dispose();
    }
  });
});
