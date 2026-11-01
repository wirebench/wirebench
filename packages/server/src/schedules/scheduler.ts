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
 *
 * Every pass goes through the job loop, one unit per tenant (hosted edition spec §19.8 guard 6): each tenant's
 * license is read there, so a tenant without `scheduled-runs` skips only its own schedules. Queued runs start
 * round-robin across the licensed tenants under the unchanged server-wide cap, from a pass and from a finished
 * run alike, so one tenant's backlog cannot starve another's. Runs in flight are keyed `tenantId:runId`. A
 * finished run's start uses the licensed tenants the last pass found, so a license change shows within one pass
 * (15 s): a tenant that lost the feature may start a queued run until then, and one that gained it waits for it.
 *
 * A start claims only in the tenants with a run waiting (Task 17 perf): each pass asks every licensed tenant, in
 * the unit it already has, and a claim that finds nothing takes its tenant off the list until the next pass. So a
 * slot coming free costs no unit in the tenants that have nothing queued, however many there are.
 */
import type { LicenseService } from '../context.js';
import { newId } from '../identity/tokens.js';
import type { TenantScope } from '../tenancy/scope.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import type { Tenancy } from '../tenancy/tenancy.js';
import { enqueueAlertsOrWarn } from './alerts/outbox.js';
import { nextFire } from './cron.js';
import { executeRun, type AbortReason, type ExecutorEnv } from './executor.js';
import * as repo from './repo.js';

export const SCHEDULER_TICK_MS = 15_000;
/** The most schedules one pass fires in one tenant; the rest wait for the next pass. */
const FIRE_BATCH = 100;
/** The pass's name in the job loop's log lines. */
export const SCHEDULER_JOB = 'scheduler';

export interface SchedulerEnv extends ExecutorEnv {
  readonly tenancy: Pick<Tenancy, 'db' | 'forEachTenant'>;
  readonly license: () => LicenseService;
  /** The executor by default; a test seam. */
  readonly execute?: (runId: string, signal: AbortSignal, scope: TenantScope) => Promise<void>;
  /** Claims up to `limit` of one tenant's queued runs, marking them running; a test seam. */
  readonly claimQueued?: (tx: TenantQuerier, limit: number, at: Date) => Promise<string[]>;
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
  /** By `tenantId:runId`: run ids are per tenant. */
  private readonly inFlight = new Map<string, { readonly abort: AbortController; readonly done: Promise<void> }>();
  /** Starts a finished run set off outside a pass, so `idle` waits for them too. */
  private readonly starting = new Set<Promise<void>>();
  /** The tenants whose license has the feature, as the last pass found them; queued runs start from these. */
  private licensed: TenantScope[] = [];
  /** Of those, the ones with a run waiting, as the last pass or claim found them. */
  private readonly waiting = new Set<string>();
  /** The tenant after the one that last got a run started: where the round-robin goes on. */
  private turn: string | undefined;
  /** One start at a time, so two finished runs freeing two slots cannot claim past the cap. */
  private starts: Promise<number> = Promise.resolve(0);

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

  /** Aborts a run this server is running in `scope`'s tenant; false when it runs elsewhere or not at all. */
  cancel(scope: TenantScope, runId: string): boolean {
    const run = this.inFlight.get(runKey(scope, runId));
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
    while (this.inFlight.size > 0 || this.starting.size > 0) {
      await Promise.all([...this.inFlight.values()].map((run) => run.done).concat([...this.starting]));
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
    let fired = 0;
    const licensed: TenantScope[] = [];
    const waiting: string[] = [];
    await this.env.tenancy.forEachTenant(
      SCHEDULER_JOB,
      async (tx, scope) => {
        // Without the feature nothing new fires or starts in this tenant; its runs under way finish.
        if (!(await this.env.license().state(scope, tx)).features.includes('scheduled-runs')) return;
        licensed.push(scope);
        // A run whose server died ends `interrupted` once past its deadline, frees its schedule and counts as
        // an errored run for its alerts.
        for (const run of await repo.interruptStaleRuns(tx, this.env.now())) {
          await enqueueAlertsOrWarn(tx, this.env, run.scheduleId, {
            ...run,
            status: 'errored',
            reason: 'interrupted',
            summary: null,
            results: [],
          });
        }
        fired += await this.fire(tx);
        if (await repo.hasQueuedRun(tx)) waiting.push(scope.tenantId);
      },
      this.env.log,
    );
    this.licensed = licensed;
    this.waiting.clear();
    for (const tenantId of waiting) this.waiting.add(tenantId);
    const started = await this.startQueued();
    return { fired, started };
  }

  /** Queues a run (or a `skipped` one) for each of the tenant's due schedules, and moves its next fire past now. */
  private async fire(tx: TenantQuerier): Promise<number> {
    const now = this.env.now();
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
  }

  /** Starts queued runs while this server has room, one start at a time. */
  private startQueued(): Promise<number> {
    const next = this.starts.then(
      () => this.startRoundRobin(),
      () => this.startRoundRobin(),
    );
    this.starts = next.catch(() => 0);
    return next;
  }

  /**
   * Round-robin across the licensed tenants, one run per tenant per turn, oldest first within each, until the
   * cap is reached or no tenant has a queued run. Each claim is one unit of its tenant.
   */
  private async startRoundRobin(): Promise<number> {
    // The licensed tenants from the one whose turn it is, then only those with a run waiting: the rotation keeps its
    // order when the tenant whose turn it is has nothing queued.
    const first = Math.max(
      0,
      this.licensed.findIndex((scope) => scope.tenantId === this.turn),
    );
    const tenants = [...this.licensed.slice(first), ...this.licensed.slice(0, first)].filter((scope) =>
      this.waiting.has(scope.tenantId),
    );
    if (tenants.length === 0) return 0;
    const claim = this.env.claimQueued ?? ((tx, limit, at) => repo.claimQueuedRuns(tx, limit, at));
    let started = 0;
    let idle = 0;
    const failing = new Set<string>();
    for (let i = 0; idle < tenants.length; i = (i + 1) % tenants.length) {
      if (this.stopped || this.settingsFree() <= 0) break;
      const scope = tenants[i]!;
      if (failing.has(scope.tenantId)) {
        idle++;
        continue;
      }
      let runId: string | undefined;
      try {
        [runId] = await this.env.tenancy.db(scope).transaction((tx) => claim(tx, 1, this.env.now()));
      } catch (error) {
        // One tenant whose claim fails is an empty turn for the rest of this round, and the rotation moves past
        // it: it never holds up the tenants after it. Logged once per round.
        failing.add(scope.tenantId);
        this.env.log.error(
          { tenantId: scope.tenantId, message: messageOf(error) },
          'scheduler could not claim a queued run for one tenant',
        );
        if (this.turn === scope.tenantId) this.turn = tenants[(i + 1) % tenants.length]!.tenantId;
        idle++;
        continue;
      }
      if (runId === undefined) {
        // Nothing left there: no more claims in this tenant until a pass finds a run waiting again.
        this.waiting.delete(scope.tenantId);
        idle++;
        continue;
      }
      idle = 0;
      this.turn = tenants[(i + 1) % tenants.length]!.tenantId;
      this.launch(scope, runId);
      started++;
    }
    return started;
  }

  private settingsFree(): number {
    return this.env.settings.concurrency - this.inFlight.size;
  }

  private launch(scope: TenantScope, runId: string): void {
    const abort = new AbortController();
    // Claimed while a stop was under way: it is marked running, so it runs straight into the shutdown.
    if (this.stopped) abort.abort('shutdown' satisfies AbortReason);
    const execute = this.env.execute ?? ((id: string, signal: AbortSignal) => executeRun(this.env, scope, id, signal));
    const key = runKey(scope, runId);
    const done = execute(runId, abort.signal, scope)
      .catch((error: unknown) => {
        this.env.log.error({ runId, tenantId: scope.tenantId, message: messageOf(error) }, 'scheduled run failed');
      })
      .finally(() => {
        this.inFlight.delete(key);
        // A slot came free: start the next queued run now rather than at the next tick.
        if (!this.stopped) {
          const start: Promise<void> = this.startQueued()
            .then(() => undefined)
            .catch((error: unknown) => {
              this.env.log.error({ message: messageOf(error) }, 'scheduler start failed');
            })
            .finally(() => this.starting.delete(start));
          this.starting.add(start);
        }
      });
    this.inFlight.set(key, { abort, done });
  }
}

const runKey = (scope: TenantScope, runId: string): string => `${scope.tenantId}:${runId}`;
