/**
 * Retention by age (webhook-capture spec §3.4): at boot and every ten minutes, captures received
 * more than `maxAgeDays` ago are deleted, a thousand at a time, so no statement holds a long lock. The
 * module stops it from an `onClose` hook, which waits for a batch under way before the pool closes.
 *
 * Captures are swept per tenant (hosted edition spec §19.8 guard 6): each pass of the job loop deletes one
 * batch in each tenant's unit, and passes repeat while any tenant had a full batch. The audit, session-log and
 * schedule sweeps reuse this class over the raw pool until their modules move (Tasks 13 to 15).
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Querier } from '../context.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import type { SetTimer } from './env.js';
import { deleteCapturesBefore } from './repo.js';

/** The capture sweep's name in the job loop's log lines. */
export const CAPTURE_SWEEP_JOB = 'capture-retention';

/** Where the sweeper deletes: one tenant at a time through the job loop, or the raw pool (modules not moved yet). */
export type SweepTarget =
  | {
      readonly tenancy: Pick<Tenancy, 'forEachTenant' | 'db'>;
      readonly job: string;
      readonly deleteBefore: (db: TenantQuerier, cutoff: Date, limit: number) => Promise<number>;
    }
  | {
      readonly db: Querier;
      /** What to delete (audit-log plan ruling 14). */
      readonly deleteBefore: (db: Querier, cutoff: Date, limit: number) => Promise<number>;
    };

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const SWEEP_BATCH = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweeperDeps {
  readonly target: SweepTarget;
  readonly maxAgeDays: number;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  /** Tests only; production deletes `SWEEP_BATCH` at a time. */
  readonly batchSize?: number;
  /** The warn line's subject; `capture sweep` by default. */
  readonly label?: string;
}

/** A sweep over the raw pool, for the modules not moved into a tenant yet (Tasks 13 to 15). */
export function rawSweepTarget(
  db: Querier,
  deleteBefore: (db: Querier, cutoff: Date, limit: number) => Promise<number>,
): SweepTarget {
  return { db, deleteBefore };
}

/** The capture sweep's target: per tenant, through the job loop. */
export function captureSweepTarget(tenancy: Pick<Tenancy, 'forEachTenant' | 'db'>): SweepTarget {
  return { tenancy, job: CAPTURE_SWEEP_JOB, deleteBefore: deleteCapturesBefore };
}

export class CaptureSweeper {
  private timer: { cancel(): void } | undefined;
  private running: Promise<number> | undefined;
  private stopped = false;

  constructor(private readonly deps: SweeperDeps) {}

  /** Sweeps now, then every {@link SWEEP_INTERVAL_MS}. */
  start(): void {
    this.tick();
  }

  /** Deletes everything past the cutoff; returns how many. A sweep under way is returned, not doubled. */
  runOnce(): Promise<number> {
    this.running ??= this.sweep().finally(() => {
      this.running = undefined;
    });
    return this.running;
  }

  /** Cancels the timer and waits for a sweep under way; it stops between batches. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    await this.running?.catch(() => 0);
  }

  private tick(): void {
    if (this.stopped) return;
    // Re-armed before the work, so one failing sweep cannot stop every later one.
    this.timer = this.deps.setTimer(() => {
      this.tick();
    }, SWEEP_INTERVAL_MS);
    void this.runOnce().catch((error: unknown) => {
      this.deps.log.warn({ err: error }, `${this.deps.label ?? 'capture sweep'} failed`);
    });
  }

  private async sweep(): Promise<number> {
    const cutoff = new Date(this.deps.now().getTime() - this.deps.maxAgeDays * DAY_MS);
    const batch = this.deps.batchSize ?? SWEEP_BATCH;
    const target = this.deps.target;
    if ('tenancy' in target) return this.sweepTenants(target, cutoff, batch);
    let total = 0;
    while (!this.stopped) {
      const deleted = await target.deleteBefore(target.db, cutoff, batch);
      total += deleted;
      if (deleted < batch) break;
    }
    return total;
  }

  /**
   * The first pass goes through the job loop, one batch in each tenant's unit. Later passes visit only the
   * tenants whose last batch was full and committed (Task 10 review M1, M2): a tenant whose unit failed is
   * logged by the loop and waits for the next interval, so a commit that keeps failing never spins.
   */
  private async sweepTenants(
    target: Extract<SweepTarget, { readonly tenancy: unknown }>,
    cutoff: Date,
    batch: number,
  ): Promise<number> {
    let total = 0;
    const counts = new Map<string, { readonly scope: TenantScope; readonly deleted: number }>();
    const pass = await target.tenancy.forEachTenant(
      target.job,
      async (tx, scope) => {
        counts.set(scope.tenantId, { scope, deleted: await target.deleteBefore(tx, cutoff, batch) });
      },
      this.deps.log,
    );
    // Counted only once the unit committed: a failed one deleted nothing.
    let full: TenantScope[] = [];
    for (const [tenantId, { scope, deleted }] of counts) {
      if (pass.failed.includes(tenantId)) continue;
      total += deleted;
      if (deleted >= batch) full.push(scope);
    }
    while (!this.stopped && full.length > 0) {
      const next: TenantScope[] = [];
      for (const scope of full) {
        if (this.stopped) break;
        try {
          const deleted = await target.tenancy.db(scope).transaction((tx) => target.deleteBefore(tx, cutoff, batch));
          total += deleted;
          if (deleted >= batch) next.push(scope);
        } catch (error) {
          this.deps.log.error({ err: error, job: target.job, tenantId: scope.tenantId }, 'a job failed for one tenant');
        }
      }
      full = next;
    }
    return total;
  }
}
