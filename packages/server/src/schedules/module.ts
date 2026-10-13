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
import { CommitStore } from '../sync/commit-store.js';
import { scheduleRunRoutes } from './run-routes.js';
import { scheduleRoutes } from './routes.js';
import { Scheduler, type SchedulerEnv } from './scheduler.js';
import { schedulesSettings } from './settings.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const SCHEDULES_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/scheduled-runs/', import.meta.url));

/** Under `<dataDir>/tmp`: each run's private copy of its workspace. */
export const SCHEDULES_TMP_DIR = 'schedules';

const MIB = 1024 * 1024;

export interface SchedulesOptions {
  /** Injected clock: timestamps, the next run and the scheduler. */
  readonly now?: () => Date;
  /** Injected timers: the scheduler's tick and each run's deadline. */
  readonly setTimer?: SetTimer;
  /** `false` keeps the scheduler from passing on its own; tests drive it through `onScheduler`. */
  readonly startScheduler?: boolean;
  /** Runs a claimed run; the executor by default. A test seam. */
  readonly execute?: SchedulerEnv['execute'];
  /** Hands the module's scheduler out, for tests. */
  readonly onScheduler?: (scheduler: Scheduler) => void;
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
        db: ctx.db,
        hooks: ctx.hooks,
        settings,
        snapshot: (workspaceId) => store.snapshot(workspaceId),
        tmpRoot: resolve(tmpDir, SCHEDULES_TMP_DIR),
        version: ctx.config.version,
        now,
        setTimer,
        log: ctx.log,
        license,
        ...(options.execute !== undefined ? { execute: options.execute } : {}),
      });
      options.onScheduler?.(scheduler);
      scheduleRoutes({ db: ctx.db, hooks: ctx.hooks, license, settings, now })(app);
      scheduleRunRoutes({
        db: ctx.db,
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
          cancel: (runId) => scheduler.cancel(runId),
        },
      })(app);
      if (options.startScheduler !== false) scheduler.start();
      app.addHook('onClose', () => scheduler.stop());
    },
  };
}
