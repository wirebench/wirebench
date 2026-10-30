/**
 * The `session-logs` ServerModule (team session logs spec A1, #430). Registered after the audit log: its
 * routes use teams-access's role guard and `ctx.license`, and it records audit events. A desktop streams
 * the masked text log of every SSH session on a recording workspace's hosts; members read it.
 *
 * Retention follows the audit log's age (R7): a log last written longer ago than
 * `WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS` is dropped by the same kind of sweep, ten minutes apart.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import type { SetTimer } from '../hooks/env.js';
import { CaptureSweeper } from '../hooks/sweep.js';
import { realTimer } from '../live/module.js';
import { removeLogsBefore } from './repo.js';
import { sessionLogRoutes } from './routes.js';

export const SESSION_LOGS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/session-logs/', import.meta.url));
export const SESSION_LOGS_CAPABILITY = 'session-logs';

export interface SessionLogsOptions {
  readonly now?: () => Date;
  readonly setTimer?: SetTimer;
}

export function sessionLogsModule(options: SessionLogsOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'session-logs',
    migrationsDir: SESSION_LOGS_MIGRATIONS_DIR,
    register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      // The workspace `recordSessionLogs` switch and these routes; a server without it hides both in the desktop.
      ctx.meta.addCapability(SESSION_LOGS_CAPABILITY);
      sessionLogRoutes({
        db: ctx.db,
        tenancy: ctx.tenancy,
        hooks: ctx.hooks,
        license: () => ctx.license,
        now,
        maxLogBytes: ctx.config.sessionLogMaxMb * 1024 * 1024,
      })(app);
      const sweeper = new CaptureSweeper({
        db: ctx.db,
        maxAgeDays: ctx.config.auditMaxAgeDays,
        now,
        setTimer,
        log: ctx.log,
        deleteBefore: removeLogsBefore,
        label: 'session-log sweep',
      });
      sweeper.start();
      app.addHook('onClose', () => sweeper.stop());
      return Promise.resolve();
    },
  };
}
