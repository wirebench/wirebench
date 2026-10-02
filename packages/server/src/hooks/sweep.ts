/**
 * Retention by age (webhook-capture spec §3.4): at boot and every ten minutes, captures received
 * more than `maxAgeDays` ago are deleted, a thousand at a time, so no statement holds a long lock. The
 * module stops it from an `onClose` hook, which waits for a batch under way before the pool closes.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Querier } from '../context.js';
import type { SetTimer } from './env.js';
import { deleteCapturesBefore } from './repo.js';

export const SWEEP_INTERVAL_MS = 10 * 60 * 1000;
export const SWEEP_BATCH = 1_000;
const DAY_MS = 24 * 60 * 60 * 1000;

export interface SweeperDeps {
  readonly db: Querier;
  readonly maxAgeDays: number;
  readonly now: () => Date;
  readonly setTimer: SetTimer;
  readonly log: FastifyBaseLogger;
  /** Tests only; production deletes `SWEEP_BATCH` at a time. */
  readonly batchSize?: number;
  /** What to delete (audit-log plan ruling 14); captures by default. */
  readonly deleteBefore?: (db: Querier, cutoff: Date, limit: number) => Promise<number>;
  /** The warn line's subject; `capture sweep` by default. */
  readonly label?: string;
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
    let total = 0;
    while (!this.stopped) {
      const deleted = await (this.deps.deleteBefore ?? deleteCapturesBefore)(this.deps.db, cutoff, batch);
      total += deleted;
      if (deleted < batch) break;
    }
    return total;
  }
}
