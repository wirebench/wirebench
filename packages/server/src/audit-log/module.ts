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
import { AuditSealer } from './chain/sealer.js';
import { desktopEventsLimiter, desktopRoutes } from './desktop-routes.js';
import { AuditForwarder } from './forward/forwarder.js';
import { sinkFromConfig } from './forward/sink.js';
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
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      // Built first: a CA file that cannot be read refuses the start (ConfigError) before anything is wired.
      const sink = await sinkFromConfig(ctx.config);
      ctx.hooks.audit.push(auditHook(now, { forward: sink !== undefined }));
      ctx.hooks.licenseChanged.push(licenseListener({ db: ctx.db, hooks: ctx.hooks, log: ctx.log }));
      ctx.meta.addCapability('audit-log');
      // The workspace `recordDesktopActivity` setting (#211); a server without it ignores the field, so the desktop hides the switch.
      ctx.meta.addCapability('desktop-activity');
      auditRoutes({ db: ctx.db, hooks: ctx.hooks, license: () => ctx.license })(app);
      desktopRoutes({ db: ctx.db, hooks: ctx.hooks, limiter: desktopEventsLimiter(now) })(app);
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
      const forwarder =
        sink === undefined
          ? undefined
          : new AuditForwarder({ db: ctx.db, sink, license: () => ctx.license, now, setTimer, log: ctx.log });
      forwarder?.start();
      // Only with a chain key (audit-chain spec §3.2); without one nothing is built and no timer armed.
      const key = ctx.config.auditChainKey;
      const sealer = key === undefined ? undefined : new AuditSealer({ db: ctx.db, key, now, setTimer, log: ctx.log });
      sealer?.start();
      // Before `startServer` drains and closes the pool (host spec §3.7): a sealing pass under way commits
      // before the sweeper stops, a sweep or a forward batch under way finishes (or rolls back, leaving its
      // events queued), and only then is the sink closed.
      app.addHook('onClose', async () => {
        await sealer?.stop();
        await sweeper.stop();
        await forwarder?.stop();
        await sink?.close();
      });
    },
  };
}
