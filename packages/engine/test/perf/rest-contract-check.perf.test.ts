import { describe, expect, it } from 'vitest';
import { SKIP_PERF, median } from '../bench/budgets.js';
import type { RestContractInput } from '../../src/rest/contract-check.js';
import { createRestContractChecker } from '../../src/rest/contract-check-worker-host.js';
import type { OpenApiResponses } from '../../src/rest/openapi/model.js';

/** A row schema of 50 typed properties, all required: the shape the budget is stated for. */
const PROPERTIES = 50;
const properties: Record<string, unknown> = {};
for (let i = 0; i < PROPERTIES; i++) {
  properties[`p${String(i)}`] = i % 2 === 0 ? { type: 'integer' } : { type: 'string', minLength: 1 };
}
const responses: OpenApiResponses = {
  '200': {
    content: { 'application/json': { schema: { type: 'object', required: Object.keys(properties), properties } } },
  },
};

/**
 * One matching object of at least 256 KiB: the string properties carry the bulk.
 *
 * One object rather than an array of small rows on purpose: the validator stops after
 * `MAX_VALIDATE_NODES` schema nodes, and a few hundred 50-property rows would pass that cap and
 * measure the cap, not the check.
 */
function body(): string {
  const one: Record<string, unknown> = {};
  const filler = Math.ceil((256 * 1024) / (PROPERTIES / 2));
  for (let i = 0; i < PROPERTIES; i++) one[`p${String(i)}`] = i % 2 === 0 ? i : 'x'.repeat(filler);
  return JSON.stringify(one);
}

describe.skipIf(SKIP_PERF)('rest contract check', () => {
  it('a 256 KiB JSON body against a 50-property schema checks in the worker in under 50 ms', { retry: 1 }, async () => {
    const bodyText = body();
    expect(bodyText.length).toBeGreaterThanOrEqual(256 * 1024);
    const input: RestContractInput = {
      status: 200,
      contentType: 'application/json',
      bodyText,
      language: 'json',
      streamed: false,
      operation: { method: 'get', path: '/rows' },
      responses,
    };
    const checker = createRestContractChecker();
    try {
      // Warm-up: the first check pays for starting the worker, which a send pays once per app run.
      const first = await checker.check(input);
      expect(first.status, JSON.stringify(first.problems.slice(0, 2))).toBe('ok');
      const samples: number[] = [];
      for (let i = 0; i < 7; i++) {
        const start = performance.now();
        const result = await checker.check(input);
        samples.push(performance.now() - start);
        expect(result.status).toBe('ok');
      }
      console.info(`[perf] rest-contract-check: median ${median(samples).toFixed(1)} ms (gate 50 ms)`);
      expect(median(samples), `samples: ${samples.map((s) => s.toFixed(1)).join(', ')} ms`).toBeLessThan(50);
    } finally {
      await checker.dispose();
    }
  });
});
