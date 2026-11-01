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
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { isDefaultTenant } from '../tenancy/tenancy.js';
import { chainKeys } from './chain/keys.js';
import { RetentionStopLog } from './chain/retention-log.js';
import { AuditSealer } from './chain/sealer.js';
import { desktopEventsLimiter, desktopRoutes } from './desktop-routes.js';
import { AuditForwarder } from './forward/forwarder.js';
import { sinkFromConfig } from './forward/sink.js';
import { auditHook } from './hook.js';
import { licenseListener } from './license-listener.js';
import { pendingWrites, type PendingWrites } from '../pending-writes.js';
import { deleteAuditEventsBefore, deleteSealedBefore, deleteUnsealedBefore, readAnchor } from './repo.js';
import { auditRoutes } from './routes.js';

export const AUDIT_LOG_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/audit-log/', import.meta.url));

/** The audit sweep's name in the job loop's log lines. */
export const AUDIT_SWEEP_JOB = 'audit-retention';

export interface AuditLogOptions {
  readonly now?: () => Date;
  readonly setTimer?: SetTimer;
  /** Hands out the license-change audit writes still in flight, for tests that must see every row a request led to. */
  readonly onLicenseWrites?: (writes: PendingWrites) => void;
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
      // Written after the license route answers: kept, so shutdown waits for them and a test can.
      const licenseWrites = pendingWrites();
      options.onLicenseWrites?.(licenseWrites);
      ctx.hooks.licenseChanged.push(
        licenseListener({ tenancy: ctx.tenancy, hooks: ctx.hooks, log: ctx.log, writes: licenseWrites }),
      );
      ctx.meta.addCapability('audit-log');
      // The workspace `recordDesktopActivity` setting (#211); a server without it ignores the field, so the desktop hides the switch.
      ctx.meta.addCapability('desktop-activity');
      auditRoutes({ tenancy: ctx.tenancy, hooks: ctx.hooks, license: () => ctx.license })(app);
      desktopRoutes({ tenancy: ctx.tenancy, hooks: ctx.hooks, limiter: desktopEventsLimiter(now) })(app);
      const configured = ctx.config.auditChainKey;
      // Each tenant's chain key (spec §19.7): the configured one for the self-hosted default tenant, else derived.
      const keys =
        configured === undefined
          ? undefined
          : chainKeys(configured, ctx.config.mode, (scope) => isDefaultTenant(ctx.tenancy, scope));
      const stops = new RetentionStopLog(ctx.log);
      // With a chain key, retention deletes only checked sealed rows from the chain's oldest end and moves
      // the anchor (audit-chain spec §3.3). Without one it deletes by `at`, but once a chain exists only
      // unsealed rows, so a missing key never cuts a gap; each batch reads the anchor, which is cheap.
      const sweeper = new CaptureSweeper({
        maxAgeDays: ctx.config.auditMaxAgeDays,
        now,
        setTimer,
        log: ctx.log,
        target: {
          tenancy: ctx.tenancy,
          job: AUDIT_SWEEP_JOB,
          deleteBefore:
            keys === undefined
              ? async (tx: TenantQuerier, cutoff: Date, limit: number) =>
                  (await readAnchor(tx)) === undefined
                    ? deleteAuditEventsBefore(tx, cutoff, limit)
                    : deleteUnsealedBefore(tx, cutoff, limit)
              : (tx: TenantQuerier, cutoff: Date, limit: number) =>
                  deleteSealedBefore(tx, keys(tx.scope), cutoff, limit, stops),
        },
        label: 'audit sweep',
      });
      sweeper.start();
      const forwarder =
        sink === undefined
          ? undefined
          : new AuditForwarder({ tenancy: ctx.tenancy, sink, license: () => ctx.license, now, setTimer, log: ctx.log });
      forwarder?.start();
      // Only with a chain key (audit-chain spec §3.2); without one nothing is built and no timer armed.
      const sealer =
        keys === undefined ? undefined : new AuditSealer({ tenancy: ctx.tenancy, keys, now, setTimer, log: ctx.log });
      sealer?.start();
      // Before `startServer` drains and closes the pool (host spec §3.7): a sealing pass under way commits
      // before the sweeper stops, a sweep or a forward batch under way finishes (or rolls back, leaving its
      // events queued), and only then is the sink closed.
      app.addHook('onClose', async () => {
        await licenseWrites.settled();
        await sealer?.stop();
        await sweeper.stop();
        await forwarder?.stop();
        await sink?.close();
      });
    },
  };
}
