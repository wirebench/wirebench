/**
 * The CI performance gate.
 *
 * Every scenario in `test/bench/scenarios.ts` runs {@link GATE_SAMPLES} times and its median
 * must come in under `budget × CI_GATE_FACTOR`. The median (rather than the best or the mean)
 * keeps one descheduled iteration on a noisy runner from failing the build, while a genuine
 * regression — normally a multiple, not a few percent — still trips it.
 *
 * Set `WIREBENCH_SKIP_PERF=1` to skip the whole file; that is the escape hatch for slow or
 * heavily loaded machines, and it is the only condition under which these tests may skip.
 */
import { describe, expect, it } from 'vitest';
import {
  BUDGETS_MS,
  CI_GATE_FACTOR,
  GATE_SAMPLES,
  SKIP_PERF,
  median,
  timeMs,
  type BudgetName,
} from '../bench/budgets.js';
import { SCENARIOS, hasCountryInfoFixture } from '../bench/scenarios.js';

const names = Object.keys(BUDGETS_MS) as BudgetName[];

describe.skipIf(SKIP_PERF)('engine performance budgets', () => {
  for (const name of names) {
    const budget = BUDGETS_MS[name];
    const gate = budget * CI_GATE_FACTOR;

    it.skipIf(name === 'countryinfo-import-generate' && !hasCountryInfoFixture())(
      `${name} stays under ${budget} ms (gate ${gate} ms)`,
      { retry: 1, timeout: 120_000 },
      async () => {
        const scenario = await SCENARIOS[name]();
        try {
          // One untimed warm-up: the first call pays for module-level lazy initialisation
          // (schema caches, undici pools) that no later send or import repeats.
          await scenario.run();

          const samples: number[] = [];
          for (let i = 0; i < GATE_SAMPLES; i++) {
            samples.push(scenario.measure !== undefined ? await scenario.measure() : await timeMs(scenario.run));
          }
          const value = median(samples);
          // Surfaced in the CI log so a slow-but-passing trend is visible before it fails.
          console.info(`[perf] ${name}: median ${value.toFixed(1)} ms (budget ${budget} ms, gate ${gate} ms)`);
          expect(value, `samples: ${samples.map((s) => s.toFixed(1)).join(', ')} ms`).toBeLessThan(gate);
        } finally {
          await scenario.dispose?.();
        }
      },
    );
  }
});
