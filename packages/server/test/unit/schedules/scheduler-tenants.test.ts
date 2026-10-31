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

/** A unit that answers every statement with no rows: the pass finds nothing stale and nothing due. */
const emptyUnit = (scope: TenantScope): TenantQuerier =>
  ({ scope, query: () => Promise.resolve({ rows: [], rowCount: 0 }) }) as unknown as TenantQuerier;

const silent = { error: () => undefined, warn: () => undefined, info: () => undefined, debug: () => undefined };

const turn = (): Promise<void> => new Promise((done) => setImmediate(done));

function cast(
  queued: Record<string, string[]>,
  features: Record<string, readonly Feature[]> = {},
  /** Tenants whose claim throws. */
  broken: readonly string[] = [],
) {
  const tenants = [ONE, TWO];
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
        for (const scope of tenants) await fn(emptyUnit(scope), scope);
        return { served: tenants.length, failed: 0 };
      },
      db: (scope: TenantScope) => ({
        scope,
        query: () => Promise.resolve({ rows: [], rowCount: 0 }),
        transaction: <T>(fn: (tx: TenantQuerier) => Promise<T>) => fn(emptyUnit(scope)),
      }),
    },
    claimQueued: (tx: TenantQuerier, limit: number) =>
      broken.includes(tx.scope.tenantId)
        ? Promise.reject(new Error('this tenant’s unit cannot open'))
        : Promise.resolve((queued[tx.scope.tenantId] ?? []).splice(0, limit)),
    execute: (runId: string, _signal: AbortSignal, scope: TenantScope) =>
      new Promise<void>((release) => {
        started.push({ tenant: scope.slug, runId, release });
      }),
  } as unknown as SchedulerEnv;
  return { scheduler: new Scheduler(env), started, errors };
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
});
