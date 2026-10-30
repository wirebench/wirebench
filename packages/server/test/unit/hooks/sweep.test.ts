import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Querier } from '../../../src/context.js';
import { deleteCapturesBefore } from '../../../src/hooks/repo.js';
import { asTenantQuerier } from '../../helpers/tenancy.js';
import {
  CAPTURE_SWEEP_JOB,
  CaptureSweeper,
  SWEEP_BATCH,
  SWEEP_INTERVAL_MS,
  captureSweepTarget,
  rawSweepTarget,
} from '../../../src/hooks/sweep.js';
import type { Tenancy } from '../../../src/tenancy/tenancy.js';

const NOW = new Date('2026-09-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Answers each delete with the next row count; `hold()` keeps the next one pending until released. */
/** The capture delete over the fake, which records the SQL a tenant unit would send. */
const capturesBefore = (db: Querier, cutoff: Date, limit: number) =>
  deleteCapturesBefore(asTenantQuerier(db), cutoff, limit);

function fakeDb(counts: number[]) {
  const calls: { readonly text: string; readonly params: readonly unknown[] }[] = [];
  let gate: Promise<void> | undefined;
  let fail: Error | undefined;
  const db: Querier = {
    query: async (text, params = []) => {
      calls.push({ text, params });
      if (gate !== undefined) await gate;
      if (fail !== undefined) throw fail;
      return { rows: [], rowCount: counts.shift() ?? 0 };
    },
  };
  return {
    db,
    calls,
    hold(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    failWith(error: Error | undefined): void {
      fail = error;
    },
  };
}

function timers() {
  const armed: { readonly fn: () => void; readonly ms: number; cancelled: boolean }[] = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      armed.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    live: () => armed.filter((timer) => !timer.cancelled),
    fire: () => {
      const due = armed.filter((timer) => !timer.cancelled);
      for (const timer of due) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

function log(warnings: unknown[]): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const logger = {
    level: 'warn',
    fatal: quiet,
    error: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('CaptureSweeper (webhook-capture §3.4)', () => {
  it('sweeps at start, in batches until one comes back short, with a strict cutoff maxAgeDays back', async () => {
    const f = fakeDb([SWEEP_BATCH, SWEEP_BATCH, 3]);
    const t = timers();
    const sweeper = new CaptureSweeper({
      target: rawSweepTarget(f.db, capturesBefore),
      maxAgeDays: 7,
      now: () => NOW,
      setTimer: t.setTimer,
      log: log([]),
    });
    sweeper.start();
    await flush();
    expect(f.calls).toHaveLength(3);
    for (const call of f.calls) {
      expect(call.text).toContain('received_at < $1');
      expect(call.params).toEqual([new Date(NOW.getTime() - 7 * DAY), SWEEP_BATCH]);
    }
    expect(t.live().map((timer) => timer.ms)).toEqual([SWEEP_INTERVAL_MS]);
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(4);
    expect(t.live().map((timer) => timer.ms)).toEqual([SWEEP_INTERVAL_MS]);
  });

  it('logs a failed sweep and still sweeps at the next interval', async () => {
    const f = fakeDb([]);
    const t = timers();
    const warnings: unknown[] = [];
    f.failWith(new Error('connection lost'));
    const sweeper = new CaptureSweeper({
      target: rawSweepTarget(f.db, capturesBefore),
      maxAgeDays: 7,
      now: () => NOW,
      setTimer: t.setTimer,
      log: log(warnings),
    });
    sweeper.start();
    await flush();
    expect(warnings).toHaveLength(1);
    f.failWith(undefined);
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it('never runs two sweeps at once', async () => {
    const f = fakeDb([0]);
    const t = timers();
    const release = f.hold();
    const sweeper = new CaptureSweeper({
      target: rawSweepTarget(f.db, capturesBefore),
      maxAgeDays: 7,
      now: () => NOW,
      setTimer: t.setTimer,
      log: log([]),
    });
    const first = sweeper.runOnce();
    expect(sweeper.runOnce()).toBe(first);
    release();
    await expect(first).resolves.toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('stop cancels the timer, waits for the batch under way, and starts no other', async () => {
    const f = fakeDb([SWEEP_BATCH, SWEEP_BATCH]);
    const t = timers();
    const release = f.hold();
    const sweeper = new CaptureSweeper({
      target: rawSweepTarget(f.db, capturesBefore),
      maxAgeDays: 7,
      now: () => NOW,
      setTimer: t.setTimer,
      log: log([]),
    });
    sweeper.start();
    await flush();
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(t.live()).toEqual([]);
    release();
    await stopping;
    expect(f.calls).toHaveLength(1); // a full batch, but stopped: no second one
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(1);
  });

  it('deletes through an injected function in batches', async () => {
    const limits: number[] = [];
    const t = timers();
    const sweeper = new CaptureSweeper({
      target: rawSweepTarget(fakeDb([]).db, (_db, _cutoff, limit) => {
        limits.push(limit);
        return Promise.resolve(limits.length === 1 ? 2 : 0);
      }),
      maxAgeDays: 1,
      now: () => new Date(),
      setTimer: t.setTimer,
      log: log([]),
      batchSize: 2,
      label: 'audit sweep',
    });
    expect(await sweeper.runOnce()).toBe(2);
    expect(limits).toEqual([2, 2]);
    await sweeper.stop();
  });
});

describe('the capture sweep per tenant (spec §19.8 guard 6)', () => {
  /**
   * Two tenants: the job loop runs every tenant's first batch, `db(scope)` a later one. `fail` makes a tenant's
   * first unit fail after its delete, as a commit that drops would.
   */
  function twoTenants(batches: Record<string, number[]>, fail: readonly string[] = []) {
    const visits: string[] = [];
    const run = async (tenant: string, fn: (tx: never) => Promise<unknown>) => {
      visits.push(tenant);
      const f = fakeDb([batches[tenant]!.shift() ?? 0]);
      return fn(asTenantQuerier(f.db) as never);
    };
    const tenancy: Pick<Tenancy, 'forEachTenant' | 'db'> = {
      forEachTenant: async (job, fn) => {
        expect(job).toBe(CAPTURE_SWEEP_JOB);
        const failed: string[] = [];
        for (const tenant of ['one', 'two']) {
          await run(tenant, (tx) => fn(tx, { tenantId: tenant } as never));
          if (fail.includes(tenant)) failed.push(tenant);
        }
        visits.push('|');
        return { served: 2 - failed.length, failed };
      },
      db: ((scope: { readonly tenantId: string }) => ({
        transaction: (fn: (tx: never) => Promise<unknown>) => run(scope.tenantId, fn),
      })) as never,
    };
    return { tenancy, visits };
  }
  const sweeperOver = (tenancy: Pick<Tenancy, 'forEachTenant' | 'db'>) =>
    new CaptureSweeper({
      target: captureSweepTarget(tenancy),
      maxAgeDays: 7,
      now: () => NOW,
      setTimer: timers().setTimer,
      log: log([]),
    });

  it('runs the first batch in every tenant, then visits only the tenants whose batch was full', async () => {
    const { tenancy, visits } = twoTenants({ one: [SWEEP_BATCH, SWEEP_BATCH, 1], two: [4] });
    expect(await sweeperOver(tenancy).runOnce()).toBe(2 * SWEEP_BATCH + 1 + 4);
    expect(visits).toEqual(['one', 'two', '|', 'one', 'one']);
  });

  it('counts nothing of a tenant whose unit failed, and never retries it in the same sweep', async () => {
    const { tenancy, visits } = twoTenants({ one: [SWEEP_BATCH, SWEEP_BATCH], two: [4] }, ['one']);
    expect(await sweeperOver(tenancy).runOnce()).toBe(4);
    expect(visits).toEqual(['one', 'two', '|']);
  });
});
