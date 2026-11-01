import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { expect, it } from 'vitest';
import { CONSERVATIVE_RATE, estimateSeconds, MEASURED_RATE, passesOf } from '../../../src/tenancy/estimate.js';

it("keeps the measured rate equal to plan Task 4's committed baseline", () => {
  const baseline = JSON.parse(
    readFileSync(join(import.meta.dirname, '../../perf/baselines/tenancy-migration.json'), 'utf8'),
  ) as { rowsPerSecond: number; heapBytesPerSecond: number };
  expect(MEASURED_RATE).toEqual({
    rowsPerSecond: baseline.rowsPerSecond,
    heapBytesPerSecond: baseline.heapBytesPerSecond,
  });
});

it('sums passes × (rows ÷ R + heap ÷ B) over the tables (spec §19.10)', () => {
  // audit_events: 6 passes; a table 0020 does not know: 1.
  expect(passesOf('audit_events')).toBe(6);
  expect(passesOf('not_a_table')).toBe(1);
  const tables = [
    { table: 'audit_events', rows: 5_000_000, heapBytes: 1_000_000_000 },
    { table: 'not_a_table', rows: 500_000, heapBytes: 0 },
  ];
  // The spec's own example: 5 million audit rows in 1 GB take 50 to 105 s at the conservative rate.
  expect(estimateSeconds(tables, CONSERVATIVE_RATE)).toBeCloseTo(6 * (10 + 5) + 1, 5);
  expect(estimateSeconds(tables, MEASURED_RATE)).toBeLessThan(estimateSeconds(tables, CONSERVATIVE_RATE));
});
