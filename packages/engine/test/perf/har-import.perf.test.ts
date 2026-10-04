import { describe, expect, it } from 'vitest';
import { BUDGETS_MS, CI_GATE_FACTOR, GATE_SAMPLES, SKIP_PERF, median } from '../bench/budgets.js';
import { mapHar } from '../../src/rest/har/map.js';
import { parseHarText } from '../../src/rest/har/parse.js';

const ENTRIES = 20_000;
const PATHS = 50;
/** Statuses cycled per path, so each request collects its full five examples. */
const STATUSES = [200, 201, 400, 404, 500, 503] as const;

/** A JSON response body of about 4 KB. */
function responseBody(i: number): string {
  const rows = Array.from({ length: 60 }, (_, row) => ({ id: row, name: `item ${String(i)}-${String(row)}` }));
  const text = JSON.stringify({ page: i, rows });
  return text.length >= 4096 ? text : JSON.stringify({ page: i, rows, pad: 'x'.repeat(4096 - text.length) });
}

/** A capture of {@link ENTRIES} calls spread over {@link PATHS} paths of one origin, built in memory. */
function capture(): string {
  const entries = Array.from({ length: ENTRIES }, (_, i) => {
    const status = STATUSES[Math.floor(i / PATHS) % STATUSES.length] ?? 200;
    const body = responseBody(i);
    return {
      startedDateTime: new Date(Date.UTC(2026, 9, 4, 10, 0, 0, i)).toISOString(),
      time: 12,
      request: {
        method: 'GET',
        url: `https://api.example.com/resource${String(i % PATHS)}?page=${String(i)}`,
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [{ name: 'Accept', value: 'application/json' }],
        queryString: [{ name: 'page', value: String(i) }],
        headersSize: -1,
        bodySize: 0,
      },
      response: {
        status,
        statusText: String(status),
        httpVersion: 'HTTP/1.1',
        cookies: [],
        headers: [{ name: 'Content-Type', value: 'application/json' }],
        content: { size: body.length, mimeType: 'application/json', text: body },
        redirectURL: '',
        headersSize: -1,
        bodySize: body.length,
      },
      cache: {},
      timings: { send: 1, wait: 10, receive: 1 },
    };
  });
  return JSON.stringify({ log: { version: '1.2', creator: { name: 'perf', version: '1' }, entries } });
}

/*
 * Held to the budget of the suite's largest import, the ~5 MB generated WSDL: a capture this size
 * (about 97 MB, just under the importer's 100 MB ceiling) is the largest thing a user will feed an import.
 */
const BUDGET = BUDGETS_MS['large-schema-import-generate'];

describe.skipIf(SKIP_PERF)('HAR import', () => {
  it(
    `a 20,000-entry capture over 50 paths maps with examples in under ${String(BUDGET)} ms`,
    { retry: 1, timeout: 120_000 },
    () => {
      const text = capture();
      const run = () => mapHar(parseHarText(text), { responses: 'examples' });
      // Warm-up, as the other engine budgets do.
      const first = run();
      expect(first.summary.kept).toBe(ENTRIES);
      expect(first.summary.requests).toBe(PATHS);
      expect(first.apis[0]?.requests.every((request) => request.examples?.length === 5)).toBe(true);
      const samples: number[] = [];
      for (let i = 0; i < GATE_SAMPLES; i++) {
        const start = performance.now();
        run();
        samples.push(performance.now() - start);
      }
      const gate = BUDGET * CI_GATE_FACTOR;
      console.info(
        `[perf] har-import-20k: median ${median(samples).toFixed(1)} ms (budget ${String(BUDGET)} ms, gate ${String(gate)} ms, ${String(Math.round(text.length / (1024 * 1024)))} MB)`,
      );
      expect(median(samples), `samples: ${samples.map((s) => s.toFixed(1)).join(', ')} ms`).toBeLessThan(gate);
    },
  );
});
