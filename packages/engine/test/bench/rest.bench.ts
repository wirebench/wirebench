/**
 * REST and OpenAPI benchmarks — trend numbers for a human, not a gate.
 *
 * Run them with `pnpm bench`; the pass/fail budget check is `test/perf/budgets.test.ts`, which drives
 * the very same scenarios so the two never measure different things.
 */
import { afterAll, describe, it } from 'vitest';
import { BUDGETS_MS } from './budgets.js';
import { SCENARIOS } from './scenarios.js';

const openApiImport = await SCENARIOS['openapi-import-1mb']();
const openApiSamples = await SCENARIOS['openapi-samples']();
const pretty = await SCENARIOS['rest-pretty-5mb']();
const sendOverhead = await SCENARIOS['rest-send-overhead']();

afterAll(async () => {
  for (const scenario of [openApiImport, openApiSamples, pretty, sendOverhead]) {
    await scenario.dispose?.();
  }
});

describe('openapi import and sample generation', () => {
  it('measures each OpenAPI scenario', { timeout: 600_000 }, async ({ bench }) => {
    await bench.compare(
      bench(`openapi-import-1mb (budget ${BUDGETS_MS['openapi-import-1mb']} ms)`, () => openApiImport.run()),
      bench(`openapi-samples (budget ${BUDGETS_MS['openapi-samples']} ms)`, () => openApiSamples.run()),
    );
  });
});

describe('rest response and send', () => {
  it('measures each REST scenario', { timeout: 600_000 }, async ({ bench }) => {
    await bench.compare(
      bench(`rest-pretty-5mb (budget ${BUDGETS_MS['rest-pretty-5mb']} ms)`, () => pretty.run()),
      bench(`rest-send-overhead (budget ${BUDGETS_MS['rest-send-overhead']} ms)`, () => sendOverhead.run()),
    );
  });
});
