/**
 * The `scheduled-runs` ServerModule (scheduled-runs spec §5.2): a workspace's suites run on cron, their
 * results kept by age, failures and recoveries alerted. Enterprise only: every route checks the
 * `scheduled-runs` feature after the role guard. It is registered after live-updates, whose hub
 * listens to its announcement, and before audit-log.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { schedulesSettings } from './settings.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const SCHEDULES_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/scheduled-runs/', import.meta.url));

export function schedulesModule(): ServerModule {
  return {
    name: 'scheduled-runs',
    migrationsDir: SCHEDULES_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(_app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = schedulesSettings(ctx.config);
      // §6: switched off, neither the routes nor the scheduler exist.
      if (!settings.enabled) {
        return;
      }
      ctx.meta.addCapability('scheduled-runs');
    },
  };
}
