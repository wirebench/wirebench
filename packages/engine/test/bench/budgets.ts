/**
 * The performance budgets for the engine, and the scenarios that measure them.
 *
 * One map, two consumers: `test/bench/*.bench.ts` (vitest `bench`, for trend numbers when a
 * human runs `pnpm vitest bench --run`) and `test/perf/budgets.test.ts` (the CI gate, which
 * runs each scenario three times and asserts the median is under `budget × CI_GATE_FACTOR`).
 *
 * Budgets are wall-clock milliseconds on a developer laptop. The gate deliberately allows
 * slack (see {@link CI_GATE_FACTOR}) so a busy or slower CI runner does not turn a green build
 * red, while a real regression — which is normally multiples, not percent — still trips it.
 */

/**
 * How much slack the gate allows on top of the budget.
 *
 * The budgets are wall-clock milliseconds on a developer laptop, and a hosted CI runner is not
 * one: the GitHub Windows runner measures `xpath-evaluate-1mb` at 320-355 ms against a 200 ms
 * budget — about 2.5x this machine's 133 ms — purely because the hardware is slower and shared.
 * Scaling the gate there keeps the budgets stated in laptop terms (the number a developer can
 * reproduce) while still tripping on a real regression, which is a multiple rather than a few
 * tens of percent. Locally the tighter 1.5x still applies.
 */
export const CI_GATE_FACTOR = process.env['CI'] === undefined ? 1.5 : 3;

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
  /** Parse, resolve and map the generated ~1 MB / 300-operation `crafted/large.json` into an API. */
  'openapi-import-1mb': 1000,
  /**
   * Generate a body sample for every request-body schema of the generated ~1 MB document, in both
   * preference combinations plus XML.
   *
   * Dominated by the `includeOptional` and XML variants, which an import does not run by default —
   * the default (required properties only) is a fraction of this. Budgeted over the expensive
   * combination because that is the one a user can turn on, and because this is the scenario that
   * bounds sample generation over a schema graph rather than a schema tree.
   */
  'openapi-samples': 1500,
  /** Pretty-print a 5 MB JSON response body, which is what the Pretty view does on arrival. */
  'rest-pretty-5mb': 500,
  /** `sendRest` wall-clock time minus the test server's own handling time (`x-server-ms`). */
  'rest-send-overhead': 20,
  /**
   * Parse 100 000 small `text/event-stream` events, fed to `createSseParser` in 4 KB chunks.
   * Measured at ~52 ms on a development laptop; budgeted at 2x that.
   */
  'sse-parse-100k-events': 104,
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
