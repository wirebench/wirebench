import { afterEach, describe, expect, it, vi } from 'vitest';
import type { RunContext } from '../../../src/run/context.js';
import { createPacer, iterationContext, runIterations, tagIteration } from '../../../src/run/iterate.js';
import { planIterations } from '../../../src/run/iterations.js';
import type { Iteration } from '../../../src/run/iterations.js';
import type { RequestOutcome, RunResult } from '../../../src/run/run.js';

function result(outcomes: readonly RequestOutcome[], environment = 'staging'): RunResult {
  const count = (outcome: RequestOutcome): number => outcomes.filter((o) => o === outcome).length;
  return {
    startedAt: '2026-10-11T00:00:00.000Z',
    environment,
    summary: {
      total: outcomes.length,
      passed: count('passed'),
      failed: count('failed'),
      errored: count('errored'),
      skipped: count('skipped'),
      durationMs: 1,
    },
    requests: outcomes.map((outcome, i) => ({
      path: `Api/r${i}`,
      group: 'Api',
      name: `r${i}`,
      protocol: 'rest',
      outcome,
      assertions: [],
      unasserted: true,
    })),
  };
}

const rows = [{ user: 'ann' }, { user: 'bob' }, { user: 'cy' }];

describe('runIterations', () => {
  it('returns a plain run exactly as its one iteration reported it', async () => {
    const only = result(['passed']);
    expect(await runIterations(planIterations({}), () => Promise.resolve(only))).toBe(only);
  });

  it('runs each iteration in order, tags every request, and sums the summary', async () => {
    const seen: Iteration[] = [];
    const merged = await runIterations(planIterations({ rows }), (iteration) => {
      seen.push(iteration);
      return Promise.resolve(result(iteration.index === 1 ? ['passed', 'failed'] : ['passed', 'passed']));
    });
    expect(seen.map((i) => i.row?.values['user'])).toEqual(['ann', 'bob', 'cy']);
    expect(merged.environment).toBe('staging');
    expect(merged.summary).toMatchObject({
      total: 6,
      passed: 5,
      failed: 1,
      errored: 0,
      skipped: 0,
      iterations: { planned: 3, run: 3 },
    });
    expect(merged.requests.map((r) => r.iteration)).toEqual([
      { index: 0, count: 3, row: 0 },
      { index: 0, count: 3, row: 0 },
      { index: 1, count: 3, row: 1 },
      { index: 1, count: 3, row: 1 },
      { index: 2, count: 3, row: 2 },
      { index: 2, count: 3, row: 2 },
    ]);
  });

  it('tags iterations without data with no row', async () => {
    const merged = await runIterations(planIterations({ iterations: 2 }), () => Promise.resolve(result(['passed'])));
    expect(merged.requests.map((r) => r.iteration)).toEqual([
      { index: 0, count: 2 },
      { index: 1, count: 2 },
    ]);
  });

  it('under bail, runs no iteration after one that failed or errored', async () => {
    const once = vi.fn((iteration: Iteration) =>
      Promise.resolve(result(iteration.index === 1 ? ['errored', 'skipped'] : ['passed'])),
    );
    const merged = await runIterations(planIterations({ rows }), once, { bail: true });
    expect(once).toHaveBeenCalledTimes(2);
    expect(merged.summary).toMatchObject({ total: 3, errored: 1, skipped: 1, iterations: { planned: 3, run: 2 } });
  });

  it('without bail, runs every iteration past a failure', async () => {
    const once = vi.fn(() => Promise.resolve(result(['failed'])));
    await runIterations(planIterations({ rows }), once);
    expect(once).toHaveBeenCalledTimes(3);
  });

  it('runs no iteration after an abort', async () => {
    const controller = new AbortController();
    const once = vi.fn(() => {
      controller.abort();
      return Promise.resolve(result(['passed']));
    });
    const merged = await runIterations(planIterations({ rows }), once, { signal: controller.signal });
    expect(once).toHaveBeenCalledTimes(1);
    expect(merged.summary.iterations).toEqual({ planned: 3, run: 1 });
  });
});

describe('tagIteration', () => {
  it('leaves a plain run’s request alone and tags any other', () => {
    const [request] = result(['passed']).requests;
    expect(tagIteration(request!, { index: 0, count: 1 })).toBe(request);
    expect(tagIteration(request!, { index: 1, count: 2 }).iteration).toEqual({ index: 1, count: 2 });
  });
});

describe('iterationContext', () => {
  const context = { overrides: {} } as unknown as RunContext;

  it('leaves a plain run’s context alone', () => {
    expect(iterationContext(context, { index: 0, count: 1 })).toBe(context);
  });

  it('adds the row and the iteration number', () => {
    const [first] = planIterations({ rows });
    expect(iterationContext(context, first!)).toMatchObject({
      data: { user: 'ann' },
      iteration: { index: 0, count: 3 },
    });
  });

  it('adds only the number for an iteration without data', () => {
    const next = iterationContext(context, { index: 1, count: 2 });
    expect(next.iteration).toEqual({ index: 1, count: 2 });
    expect(next.data).toBeUndefined();
  });
});

describe('createPacer', () => {
  afterEach(() => {
    vi.useRealTimers();
  });

  it('waits nothing before the first send and the delay before each later one', async () => {
    vi.useFakeTimers();
    const pacer = createPacer(100);
    await pacer.wait();
    let waited = false;
    const second = pacer.wait().then(() => {
      waited = true;
    });
    await vi.advanceTimersByTimeAsync(99);
    expect(waited).toBe(false);
    await vi.advanceTimersByTimeAsync(1);
    await second;
    expect(waited).toBe(true);
  });

  it('ends a wait at once on abort', async () => {
    vi.useFakeTimers();
    const controller = new AbortController();
    const pacer = createPacer(60_000, controller.signal);
    await pacer.wait();
    const waiting = pacer.wait();
    controller.abort();
    await expect(waiting).resolves.toBeUndefined();
  });

  it('never waits without a delay', async () => {
    const pacer = createPacer(undefined);
    await pacer.wait();
    await pacer.wait();
  });
});
