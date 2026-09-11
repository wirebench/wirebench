/**
 * Import/generate benchmarks — trend numbers for a human, not a gate.
 *
 * Run them with `pnpm bench`; the pass/fail budget check is `test/perf/budgets.test.ts`, which
 * drives the very same scenarios so the two never measure different things.
 *
 * Vitest 5 registers benchmarks through the test context (`({ bench })`) rather than the
 * removed top-level `bench()` export, so each group is one ordinary test whose body compares
 * the registered benchmarks; results are reported once the test resolves.
 */
import { afterAll, describe, it } from 'vitest';
import { BUDGETS_MS } from './budgets.js';
import { SCENARIOS } from './scenarios.js';

const calculator = await SCENARIOS['calculator-import-generate']();
const countryInfo = await SCENARIOS['countryinfo-import-generate']();
const largeSchema = await SCENARIOS['large-schema-import-generate']();

afterAll(async () => {
  for (const scenario of [calculator, countryInfo, largeSchema]) {
    await scenario.dispose?.();
  }
});

describe('wsdl import + sample generation', () => {
  it('measures each import scenario', { timeout: 600_000 }, async ({ bench }) => {
    await bench.compare(
      bench(`calculator-import-generate (budget ${BUDGETS_MS['calculator-import-generate']} ms)`, () =>
        calculator.run(),
      ),
      bench(`countryinfo-import-generate (budget ${BUDGETS_MS['countryinfo-import-generate']} ms)`, () =>
        countryInfo.run(),
      ),
      bench(`large-schema-import-generate (budget ${BUDGETS_MS['large-schema-import-generate']} ms)`, () =>
        largeSchema.run(),
      ),
    );
  });
});
