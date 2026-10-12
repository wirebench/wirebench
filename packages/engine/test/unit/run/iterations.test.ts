import { describe, expect, it } from 'vitest';
import { MAX_ITERATIONS, planIterations } from '../../../src/run/iterations.js';

const rows = [{ n: 'a' }, { n: 'b' }, { n: 'c' }];
const rowIndexes = (plan: ReturnType<typeof planIterations>): (number | undefined)[] =>
  plan.map((iteration) => iteration.row?.index);

describe('planIterations', () => {
  it('runs once without data or a count', () => {
    expect(planIterations({})).toEqual([{ index: 0, count: 1 }]);
  });

  it('runs the asked count without data, with no rows', () => {
    expect(planIterations({ iterations: 3 })).toEqual([
      { index: 0, count: 3 },
      { index: 1, count: 3 },
      { index: 2, count: 3 },
    ]);
  });

  it('runs once per row when no count is given', () => {
    const plan = planIterations({ rows });
    expect(plan).toHaveLength(3);
    expect(plan[1]).toEqual({ index: 1, count: 3, row: { index: 1, values: { n: 'b' } } });
  });

  it('runs fewer iterations than rows when asked', () => {
    expect(rowIndexes(planIterations({ rows, iterations: 2 }))).toEqual([0, 1]);
  });

  it('stops after the last row by default', () => {
    const plan = planIterations({ rows, iterations: 5 });
    expect(rowIndexes(plan)).toEqual([0, 1, 2]);
    expect(plan[0]!.count).toBe(3);
  });

  it('wraps round to row 1', () => {
    expect(rowIndexes(planIterations({ rows, iterations: 5, overrun: 'wrap' }))).toEqual([0, 1, 2, 0, 1]);
  });

  it('repeats the last row', () => {
    expect(rowIndexes(planIterations({ rows, iterations: 5, overrun: 'repeat-last' }))).toEqual([0, 1, 2, 2, 2]);
  });

  it('refuses a count outside 1 to the maximum', () => {
    for (const iterations of [0, -1, 1.5, MAX_ITERATIONS + 1]) {
      expect(() => planIterations({ iterations })).toThrow(/whole number/);
    }
  });
});
