/**
 * The `audit-log` ServerModule (audit-log spec §5.1). Registered last: its routes need identity's guard
 * and `ctx.license`. Its hook is found at call time by every fire site, so for recording the order
 * does not matter. Recording is on for every edition; reading is gated (§3.1).
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import type { SetTimer } from '../hooks/env.js';
import { CaptureSweeper } from '../hooks/sweep.js';
import { realTimer } from '../live/module.js';
import { auditHook } from './hook.js';
import { licenseListener } from './license-listener.js';
import { deleteAuditEventsBefore } from './repo.js';
import { auditRoutes } from './routes.js';

export const AUDIT_LOG_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/audit-log/', import.meta.url));

export interface AuditLogOptions {
  readonly now?: () => Date;
  readonly setTimer?: SetTimer;
}

export function auditLogModule(options: AuditLogOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  return {
    name: 'audit-log',
    migrationsDir: AUDIT_LOG_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      ctx.hooks.audit.push(auditHook(now));
      ctx.hooks.licenseChanged.push(licenseListener({ db: ctx.db, hooks: ctx.hooks, log: ctx.log }));
      ctx.meta.addCapability('audit-log');
      auditRoutes({ db: ctx.db, hooks: ctx.hooks, license: () => ctx.license })(app);
      const sweeper = new CaptureSweeper({
        db: ctx.db,
        maxAgeDays: ctx.config.auditMaxAgeDays,
        now,
        setTimer,
        log: ctx.log,
        deleteBefore: deleteAuditEventsBefore,
        label: 'audit sweep',
      });
      sweeper.start();
      // Before `startServer` drains and closes the pool (host spec §3.7): a batch under way finishes.
      app.addHook('onClose', () => sweeper.stop());
    },
  };
}
