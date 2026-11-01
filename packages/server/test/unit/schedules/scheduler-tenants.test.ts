/**
 * The scheduler across tenants, over a fake job loop (hosted edition spec §19.8 guard 6): queued runs start
 * round-robin under the server-wide cap, from a pass and from a finished run alike, and a tenant whose license
 * lacks `scheduled-runs` is skipped while the others run.
 */
import type { Feature } from '@wirebench/engine';
import { describe, expect, it } from 'vitest';
import { permissiveLicense, type LicenseService } from '../../../src/context.js';
import { Scheduler, type SchedulerEnv } from '../../../src/schedules/scheduler.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import type { TenantQuerier } from '../../../src/tenancy/tenant-db.js';

const ONE = scopeOf({ id: '00000000-0000-4000-8000-000000000001', slug: 'one' });
const TWO = scopeOf({ id: '00000000-0000-4000-8000-000000000002', slug: 'two' });

/**
 * A unit that finds nothing stale and nothing due, and answers whether the tenant has a run waiting from `queued`.
 * `asked` counts the units opened.
 */
const unitOver =
  (queued: Record<string, string[]>, asked: string[]) =>
  (scope: TenantScope): TenantQuerier =>
    ({
      scope,
      query: (text: string) => {
        asked.push(scope.slug);
        const rows = text.includes("status = 'queued'") ? [{ queued: (queued[scope.tenantId] ?? []).length > 0 }] : [];
        return Promise.resolve({ rows, rowCount: rows.length });
      },
    }) as unknown as TenantQuerier;

const silent = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

function cast(
  queued: Record<string, string[]>,
  features: Record<string, readonly Feature[]> = {},
  /** Tenants whose claim throws. */
  broken: readonly string[] = [],
  /** Called after each tenant's pass unit: a Run now that lands mid-pass. */
  afterUnit: (scope: TenantScope) => void = () => undefined,
  /** Called at each claim, which then takes a turn of the event loop, as a real unit does. */
  onClaim?: (scope: TenantScope) => void,
) {
  const tenants = [ONE, TWO];
  const asked: string[] = [];
  const emptyUnit = unitOver(queued, asked);
  /** The claims made, by tenant slug. */
  const claims: string[] = [];
  const errors: unknown[][] = [];
  const started: { tenant: string; runId: string; release: () => void }[] = [];
  const license: LicenseService = {
    ...permissiveLicense(),
    state: (of) => {
      const tenantId = (of as TenantScope).tenantId;
      return Promise.resolve({
        edition: 'enterprise' as const,
        status: 'active' as const,
        seats: { used: 0, limit: null },
        features: [...(features[tenantId] ?? ['scheduled-runs'])],
      });
    },
  };
  const env = {
    settings: { concurrency: 1 },
    now: () => new Date('2026-10-30T12:00:00Z'),
    setTimer: () => ({ cancel: () => undefined }),
    log: { ...silent, error: (...args: unknown[]) => errors.push(args) },
    license: () => license,
    tenancy: {
      forEachTenant: async (_job: string, fn: (tx: TenantQuerier, scope: TenantScope) => Promise<unknown>) => {
        for (const scope of tenants) {
          await fn(emptyUnit(scope), scope);
          afterUnit(scope);
        }
        return { served: tenants.length, failed: 0 };
      },
      db: (scope: TenantScope) => ({
        scope,
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
        transaction: <T>(fn: (tx: TenantQuerier) => Promise<T>) => fn(emptyUnit(scope)),
      }),
    },
    claimQueued: async (tx: TenantQuerier, limit: number) => {
      claims.push(tx.scope.slug);
      if (onClaim !== undefined) {
        onClaim(tx.scope);
        await turn();
      }
      return broken.includes(tx.scope.tenantId)
        ? Promise.reject(new Error('this tenant’s unit cannot open'))
        : Promise.resolve((queued[tx.scope.tenantId] ?? []).splice(0, limit));
    },
    execute: (runId: string, _signal: AbortSignal, scope: TenantScope) =>
      new Promise<void>((release) => {
        started.push({ tenant: scope.slug, runId, release });
      }),
  } as unknown as SchedulerEnv;
  return { scheduler: new Scheduler(env), started, errors, claims };
}

/** Releases the running run, lets the freed slot's start happen, until nothing new starts. */
async function drain(started: { release: () => void }[]): Promise<void> {
  for (let released = 0; released < started.length; released++) {
    started[released]!.release();
    for (let i = 0; i < 5; i++) await turn();
  }
}

describe('Scheduler across tenants', () => {
  it('starts queued runs round-robin under the cap, from a pass and from a finished run', async () => {
    const { scheduler, started } = cast({
      [ONE.tenantId]: ['a1', 'a2', 'a3', 'a4', 'a5'],
      [TWO.tenantId]: ['b1'],
    });
    const pass = await scheduler.runOnce();
    expect(pass.started).toBe(1);
    expect(started.map((run) => run.runId)).toEqual(['a1']);

    await drain(started);
    expect(started.map((run) => run.tenant)).toEqual(['one', 'two', 'one', 'one', 'one', 'one']);
    expect(started.map((run) => run.runId)).toEqual(['a1', 'b1', 'a2', 'a3', 'a4', 'a5']);
    await scheduler.idle();
    expect(scheduler.running).toBe(0);
  });

  it('skips a tenant whose license lacks the feature, and runs the other', async () => {
    const { scheduler, started } = cast({ [ONE.tenantId]: ['a1'], [TWO.tenantId]: ['b1'] }, { [ONE.tenantId]: [] });
    await scheduler.runOnce();
    await drain(started);
    expect(started.map((run) => run.runId)).toEqual(['b1']);
    await scheduler.idle();
  });

  it('moves past a tenant whose claim fails, so the tenants after it still start their runs', async () => {
    const { scheduler, started, errors } = cast(
      { [ONE.tenantId]: ['a1', 'a2'], [TWO.tenantId]: ['b1', 'b2', 'b3'] },
      {},
      [ONE.tenantId],
    );
    await scheduler.runOnce();
    await drain(started);
    expect(started.map((run) => run.runId)).toEqual(['b1', 'b2', 'b3']);
    // Once per round: the pass's, and each finished run's.
    expect(errors.length).toBeLessThanOrEqual(started.length + 1);
    expect(errors[0]).toEqual([
      { tenantId: ONE.tenantId, message: 'this tenant’s unit cannot open' },
      'scheduler could not claim a queued run for one tenant',
    ]);
    await scheduler.idle();
  });

  it('claims nowhere a pass found nothing waiting, and stops claiming where a claim came back empty (Task 17)', async () => {
    const { scheduler, started, claims } = cast({ [ONE.tenantId]: [], [TWO.tenantId]: ['b1', 'b2'] });
    await scheduler.runOnce();
    // ONE has nothing queued: no claim unit there, from the pass or from a finished run.
    await drain(started);
    expect(started.map((run) => run.runId)).toEqual(['b1', 'b2']);
    expect(claims.filter((slug) => slug === 'one')).toEqual([]);
    // TWO's last claim found nothing; a later finished run claims nowhere.
    const after = claims.length;
    await drain(started);
    expect(claims).toHaveLength(after);
    await scheduler.idle();
  });

  it('a Run now landing mid-pass, after its tenant was asked, starts in that pass, not at the next tick (M2)', async () => {
    const queued: Record<string, string[]> = { [ONE.tenantId]: [], [TWO.tenantId]: [] };
    const ref: { scheduler?: Scheduler } = {};
    const { scheduler, started } = cast(queued, {}, [], (scope) => {
      // ONE was asked and had nothing; its run commits now, while the pass is in TWO.
      if (scope.tenantId !== TWO.tenantId || queued[ONE.tenantId]!.length > 0) return;
      queued[ONE.tenantId]!.push('manual');
      ref.scheduler!.kick(ONE);
    });
    ref.scheduler = scheduler;
    await scheduler.runOnce();
    for (let i = 0; i < 10; i++) await turn();
    expect(started.map((run) => run.runId)).toEqual(['manual']);
    await drain(started);
    await scheduler.idle();
  });

  it('idle and stop wait for the start a Run now makes after the pass merged its kicks (Task 17 fix re-review N1)', async () => {
    for (const end of ['idle', 'stop'] as const) {
      // TWO has a run when the pass asks, gone by its claim; ONE's Run now lands during that claim, after the merge.
      const queued: Record<string, string[]> = { [ONE.tenantId]: [], [TWO.tenantId]: ['b1'] };
      const ref: { scheduler?: Scheduler } = {};
      const { scheduler, started, claims } = cast(
        queued,
        {},
        [],
        (scope) => {
          if (scope.tenantId === TWO.tenantId) queued[TWO.tenantId]!.length = 0;
        },
        (scope) => {
          if (scope.tenantId !== TWO.tenantId || queued[ONE.tenantId]!.length > 0) return;
          queued[ONE.tenantId]!.push('manual');
          ref.scheduler!.kick(ONE);
        },
      );
      ref.scheduler = scheduler;
      await scheduler.runOnce();
      // idle: called with no turn of the loop in between. stop: called once the kick's claim is under way (a stop
      // before it makes no claim at all). Either way the kick's start must be one of what they wait for.
      if (end === 'stop') for (let i = 0; i < 10 && !claims.includes('one'); i++) await turn();
      expect(claims, end).toContain(end === 'stop' ? 'one' : 'two');
      let settled = false;
      const waiting = (end === 'idle' ? scheduler.idle() : scheduler.stop()).then(() => {
        settled = true;
      });
      for (let i = 0; i < 10 && started.length === 0; i++) await turn();
      expect(
        started.map((run) => run.runId),
        end,
      ).toEqual(['manual']);
      // Still waiting: the kicked run is in flight (on stop, started into the shutdown).
      expect(settled, end).toBe(false);
      started[0]!.release();
      await waiting;
      const after = claims.length;
      for (let i = 0; i < 10; i++) await turn();
      expect(claims, end).toHaveLength(after);
    }
  });

  it('a Run now with no pass under way starts at once', async () => {
    const queued: Record<string, string[]> = { [ONE.tenantId]: [] };
    const { scheduler, started } = cast(queued);
    await scheduler.runOnce();
    queued[ONE.tenantId]!.push('manual');
    scheduler.kick(ONE);
    for (let i = 0; i < 10; i++) await turn();
    expect(started.map((run) => run.runId)).toEqual(['manual']);
    await drain(started);
    await scheduler.idle();
  });
});
