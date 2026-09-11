/**
 * The performance budgets for the engine, and the scenarios that measure them.
 *
 * One map, two consumers: `test/bench/*.bench.ts` (vitest `bench`, for trend numbers when a
 * human runs `pnpm vitest bench --run`) and `test/perf/budgets.test.ts` (the CI gate, which
 * runs each scenario three times and asserts the median is under `budget × CI_GATE_FACTOR`).
 *
 * Budgets are wall-clock milliseconds on a developer laptop. The gate deliberately allows
 * 1.5× so a busy CI runner does not turn a green build red, while a real regression — which
 * is normally multiples, not percent — still trips it.
 */

/** How much slack the CI gate allows on top of the budget. */
export const CI_GATE_FACTOR = 1.5;

/** How many times the CI gate runs each scenario before taking the median. */
export const GATE_SAMPLES = 3;

/**
 * Engine performance budgets in milliseconds, keyed by scenario name. Exported separately from
 * the scenario factories so both the bench files and the gate quote the same numbers, and so a
 * budget change is a one-line diff in one place.
 */
export const BUDGETS_MS = {
  /** Import the 36 KB Calculator WSDL from disk and generate a sample request for `Add`. */
  'calculator-import-generate': 100,
  /** Import the public CountryInfo WSDL from disk and generate a sample request. */
  'countryinfo-import-generate': 300,
  /** Import the generated ~5 MB `crafted/large-schema` fixture and generate a sample request. */
  'large-schema-import-generate': 3000,
  /** `sendSoapRequest` wall-clock time minus the test server's own handling time (`x-server-ms`). */
  'send-overhead': 20,
  /** Build an MTOM `multipart/related` package around a 10 MB attachment. */
  'mtom-package-10mb': 500,
  /** Evaluate an XPath expression over a 1 MB SOAP response. */
  'xpath-evaluate-1mb': 200,
} as const satisfies Readonly<Record<string, number>>;

/** The name of a budgeted scenario. */
export type BudgetName = keyof typeof BUDGETS_MS;

/** True when the perf suite should be skipped — set `WIREBENCH_SKIP_PERF=1` on slow machines. */
export const SKIP_PERF = process.env['WIREBENCH_SKIP_PERF'] === '1';

/** The median of a non-empty list of samples; the gate's statistic of choice (outlier-proof). */
export function median(samples: readonly number[]): number {
  const sorted = [...samples].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  if (sorted.length % 2 === 1) {
    return sorted[middle] ?? 0;
  }
  return ((sorted[middle - 1] ?? 0) + (sorted[middle] ?? 0)) / 2;
}

/** Times one call of `fn` in milliseconds. */
export async function timeMs(fn: () => Promise<void> | void): Promise<number> {
  const started = performance.now();
  await fn();
  return performance.now() - started;
}
