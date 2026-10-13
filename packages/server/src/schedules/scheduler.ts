/**
 * Fires due schedules and runs what is queued (scheduled-runs spec §3.1). Every 15 s one pass claims the
 * due schedules with `for update skip locked`, so two servers on one database never fire a schedule twice;
 * moves each one's `next_run_at` past now, so missed fires collapse to one; queues a run, or records a
 * `skipped` run when one is still open; then starts queued runs, oldest first, up to this server's cap.
 *
 * The loop mirrors the audit forwarder: `start` passes at once and re-arms an injected timer, `stop`
 * cancels it and aborts the runs in flight, which end `cancelled` with reason `shutdown`. A run left
 * `running` by a server that died ends `interrupted` once it is past its deadline: the first pass after
 * a restart finds it, and a server sharing the database finds it too.
 */
import type { LicenseService } from '../context.js';
import { newId } from '../identity/tokens.js';
import { nextFire } from './cron.js';
import { executeRun, type AbortReason, type ExecutorEnv } from './executor.js';
import * as repo from './repo.js';

export const SCHEDULER_TICK_MS = 15_000;
/** The most schedules one pass fires; the rest wait for the next pass. */
const FIRE_BATCH = 100;

export interface SchedulerEnv extends ExecutorEnv {
  readonly license: () => LicenseService;
  /** The executor by default; a test seam. */
  readonly execute?: (runId: string, signal: AbortSignal) => Promise<void>;
}

export interface SchedulerPass {
  readonly fired: number;
  readonly started: number;
}

const messageOf = (error: unknown): string => (error instanceof Error ? error.message : String(error));

export class Scheduler {
  private timer: { cancel(): void } | undefined;
  private passing: Promise<SchedulerPass> | undefined;
  private stopped = false;
  private readonly inFlight = new Map<string, { readonly abort: AbortController; readonly done: Promise<void> }>();

  constructor(private readonly env: SchedulerEnv) {}

  /** Passes now, then every {@link SCHEDULER_TICK_MS}. */
  start(): void {
    this.tick();
  }

  /** One pass. A pass under way is returned, not doubled. */
  runOnce(): Promise<SchedulerPass> {
    this.passing ??= this.pass().finally(() => {
      this.passing = undefined;
    });
    return this.passing;
  }

  /** Aborts a run this server is running; false when it runs elsewhere or not at all. */
  cancel(runId: string): boolean {
    const run = this.inFlight.get(runId);
    run?.abort.abort('cancelled' satisfies AbortReason);
    return run !== undefined;
  }

  /** How many runs this server is running. */
  get running(): number {
    return this.inFlight.size;
  }

  /** Waits until no pass is under way and no run is in flight. */
  async idle(): Promise<void> {
    await this.passing?.catch(() => undefined);
    while (this.inFlight.size > 0) {
      await Promise.all([...this.inFlight.values()].map((run) => run.done));
    }
  }

  /** Cancels the timer, aborts every run in flight and waits for them to be stored. */
  async stop(): Promise<void> {
    this.stopped = true;
    this.timer?.cancel();
    this.timer = undefined;
    for (const run of this.inFlight.values()) run.abort.abort('shutdown' satisfies AbortReason);
    await this.idle();
  }

  private tick(): void {
    if (this.stopped) return;
    void this.runOnce()
      .catch((error: unknown) => {
        this.env.log.error({ message: messageOf(error) }, 'scheduler pass failed');
      })
      .finally(() => {
        this.arm();
      });
  }

  private arm(): void {
    if (this.stopped) return;
    this.timer = this.env.setTimer(() => {
      this.timer = undefined;
      this.tick();
    }, SCHEDULER_TICK_MS);
  }

  private async pass(): Promise<SchedulerPass> {
    if (this.stopped) return { fired: 0, started: 0 };
    // Without the feature nothing new fires or starts; runs under way finish.
    const state = await this.env.license().state();
    if (!state.features.includes('scheduled-runs')) return { fired: 0, started: 0 };
    // A run whose server died ends `interrupted` once past its deadline, and frees its schedule.
    await repo.interruptStaleRuns(this.env.db, this.env.now());
    const fired = await this.fire();
    const started = await this.startQueued();
    return { fired, started };
  }

  /** Queues a run (or a `skipped` one) for each due schedule, and moves its next fire past now. */
  private fire(): Promise<number> {
    const now = this.env.now();
    return this.env.db.transaction(async (tx) => {
      const due = await repo.claimDueSchedules(tx, now, FIRE_BATCH);
      for (const schedule of due) {
        const open = await repo.hasOpenRun(tx, schedule.id);
        await repo.insertRun(tx, {
          id: newId(),
          scheduleId: schedule.id,
          trigger: 'schedule',
          status: open ? 'skipped' : 'queued',
          ...(open ? { reason: 'overlap' } : {}),
          at: now,
        });
        await repo.setNextRunAt(tx, schedule.id, nextFire(schedule.cron, schedule.timeZone, now));
      }
      return due.length;
    });
  }

  /** Starts queued runs, oldest first, while this server has room. */
  private async startQueued(): Promise<number> {
    const free = this.env.settings.concurrency - this.inFlight.size;
    if (free <= 0 || this.stopped) return 0;
    const claimed = await this.env.db.transaction((tx) => repo.claimQueuedRuns(tx, free, this.env.now()));
    for (const runId of claimed) this.launch(runId);
    return claimed.length;
  }

  private launch(runId: string): void {
    const abort = new AbortController();
    const execute = this.env.execute ?? ((id, signal) => executeRun(this.env, id, signal));
    const done = execute(runId, abort.signal)
      .catch((error: unknown) => {
        this.env.log.error({ runId, message: messageOf(error) }, 'scheduled run failed');
      })
      .finally(() => {
        this.inFlight.delete(runId);
        // A slot came free: start the next queued run now rather than at the next tick.
        if (!this.stopped) {
          void this.startQueued().catch((error: unknown) => {
            this.env.log.error({ message: messageOf(error) }, 'scheduler start failed');
          });
        }
      });
    this.inFlight.set(runId, { abort, done });
  }
}
