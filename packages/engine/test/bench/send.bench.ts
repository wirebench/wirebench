/**
 * Send-path benchmarks: the HTTP exchange itself, MTOM packaging and XPath evaluation.
 *
 * Run them with `pnpm bench`; `test/perf/budgets.test.ts` is the pass/fail gate over the same
 * scenarios. See `import.bench.ts` for why benchmarks are registered from the test context.
 *
 * One caveat on `send-overhead`: tinybench times the scenario's `run`, which is the *whole*
 * loopback exchange, whereas the budget (and the gate, via the scenario's `measure`) covers
 * only what the engine adds on top of a bare `fetch`. So the bench number here is an upper
 * bound on the budgeted quantity, not the quantity itself.
 */
import { afterAll, describe, it } from 'vitest';
import { BUDGETS_MS } from './budgets.js';
import { SCENARIOS } from './scenarios.js';

const send = await SCENARIOS['send-overhead']();
const mtom = await SCENARIOS['mtom-package-10mb']();
const xpath = await SCENARIOS['xpath-evaluate-1mb']();

afterAll(async () => {
  for (const scenario of [send, mtom, xpath]) {
    await scenario.dispose?.();
  }
});

describe('send path', () => {
  it('measures each send-path scenario', { timeout: 600_000 }, async ({ bench }) => {
    await bench.compare(
      bench(`send-overhead (budget ${BUDGETS_MS['send-overhead']} ms)`, () => send.run()),
      bench(`mtom-package-10mb (budget ${BUDGETS_MS['mtom-package-10mb']} ms)`, () => mtom.run()),
      bench(`xpath-evaluate-1mb (budget ${BUDGETS_MS['xpath-evaluate-1mb']} ms)`, () => xpath.run()),
    );
  });
});
