/**
 * The `scheduled-runs` ServerModule (scheduled-runs spec §5.2): a workspace's suites run on cron, their
 * results kept by age, failures and recoveries alerted. Enterprise only: every route checks the
 * `scheduled-runs` feature after the role guard, and the scheduler fires nothing without it. It is
 * registered after live-updates, whose hub listens to its announcement, and before audit-log.
 */
import { resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import type { SetTimer } from '../hooks/env.js';
import { realTimer } from '../live/module.js';
import { TMP_DIR } from '../repos/repo-store.js';
import { CaptureSweeper } from '../hooks/sweep.js';
import { CommitStore } from '../sync/commit-store.js';
import { AlertOutbox, alertDelivery, type DeliverAlert } from './alerts/outbox.js';
import { deleteOutboxBefore, deleteRunsBefore } from './repo.js';
import { scheduleRunRoutes } from './run-routes.js';
import { scheduleRoutes } from './routes.js';
import { Scheduler, type SchedulerEnv } from './scheduler.js';
import { schedulesSettings } from './settings.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const SCHEDULES_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/scheduled-runs/', import.meta.url));

/** Under `<dataDir>/tmp`: each run's private copy of its workspace. */
export const SCHEDULES_TMP_DIR = 'schedules';

const MIB = 1024 * 1024;
/** Delivered and dead alert deliveries are kept this long, for a look at what went out. */
export const OUTBOX_MAX_AGE_DAYS = 7;

export interface SchedulesOptions {
  /** Injected clock: timestamps, the next run and the scheduler. */
  readonly now?: () => Date;
  /** Injected timers: the scheduler's tick and each run's deadline. */
  readonly setTimer?: SetTimer;
  /** `false` keeps the scheduler and the sweepers from passing on their own; tests drive them. */
  readonly startScheduler?: boolean;
  /** Runs a claimed run; the executor by default. A test seam. */
  readonly execute?: SchedulerEnv['execute'];
  /** Hands the module's scheduler out, for tests. */
  readonly onScheduler?: (scheduler: Scheduler) => void;
  /** Sends one alert; SMTP and HTTPS by default. A test seam. */
  readonly deliver?: DeliverAlert;
  /** Hands the module's alert outbox out, for tests. */
  readonly onOutbox?: (outbox: AlertOutbox) => void;
}

export function schedulesModule(options: SchedulesOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'scheduled-runs',
    migrationsDir: SCHEDULES_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = schedulesSettings(ctx.config);
      // §6: switched off, neither the routes nor the scheduler exist.
      if (!settings.enabled) {
        return;
      }
      ctx.meta.addCapability('scheduled-runs');
      const tmpDir = resolve(ctx.config.dataDir, TMP_DIR);
      // Snapshots only: the store's own cap is lifted to the schedules' one, which materialise enforces.
      const store = new CommitStore({
        git: ctx.git.withPlumbing(),
        repos: ctx.repos,
        tmpDir,
        limitBytes: Math.max(settings.maxSnapshotBytes, ctx.config.bodyLimitMb * MIB),
      });
      const license = (): typeof ctx.license => ctx.license;
      const scheduler = new Scheduler({
        tenancy: ctx.tenancy,
        hooks: ctx.hooks,
        settings,
        // The store's path is still the workspace id's until the per-tenant layout (Task 21).
        snapshot: (_scope, workspaceId) => store.snapshot(workspaceId),
        tmpRoot: resolve(tmpDir, SCHEDULES_TMP_DIR),
        version: ctx.config.version,
        now,
        setTimer,
        log: ctx.log,
        egress: ctx.egress,
        license,
        ...(options.execute !== undefined ? { execute: options.execute } : {}),
      });
      options.onScheduler?.(scheduler);
      const deliver = options.deliver ?? alertDelivery(settings, { egress: ctx.egress });
      const outbox = new AlertOutbox({ tenancy: ctx.tenancy, now, setTimer, log: ctx.log, license, deliver });
      options.onOutbox?.(outbox);
      scheduleRoutes({ tenancy: ctx.tenancy, hooks: ctx.hooks, license, settings, now, deliver })(app);
      scheduleRunRoutes({
        tenancy: ctx.tenancy,
        hooks: ctx.hooks,
        license,
        now,
        runs: {
          // Run now starts at once rather than at the next tick.
          kick: () => {
            void scheduler.runOnce().catch((error: unknown) => {
              ctx.log.error(
                { message: error instanceof Error ? error.message : String(error) },
                'scheduler pass failed',
              );
            });
          },
          cancel: (scope, runId) => scheduler.cancel(scope, runId),
        },
      })(app);
      // Retention (§3.6): runs past the maximum age with their results, and finished deliveries after a week.
      const sweepers = [
        new CaptureSweeper({
          maxAgeDays: settings.maxAgeDays,
          now,
          setTimer,
          log: ctx.log,
          target: { tenancy: ctx.tenancy, job: 'schedule-run-retention', deleteBefore: deleteRunsBefore },
          label: 'schedule run sweep',
        }),
        new CaptureSweeper({
          maxAgeDays: OUTBOX_MAX_AGE_DAYS,
          now,
          setTimer,
          log: ctx.log,
          target: { tenancy: ctx.tenancy, job: 'schedule-alert-retention', deleteBefore: deleteOutboxBefore },
          label: 'schedule alert sweep',
        }),
      ];
      if (options.startScheduler !== false) {
        scheduler.start();
        outbox.start();
        for (const sweeper of sweepers) sweeper.start();
      }
      app.addHook('onClose', async () => {
        await scheduler.stop();
        await outbox.stop();
        await Promise.all(sweepers.map((sweeper) => sweeper.stop()));
      });
    },
  };
}
