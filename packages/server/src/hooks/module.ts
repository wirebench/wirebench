/**
 * The `webhook-capture` ServerModule (spec §3.1). It is registered after server-sync and before
 * live-updates in the shared `/api/v1` scope: its management routes need teams-access's role guard,
 * and the live hub subscribes to its announcements. Its public route is served at the root, outside
 * `/api/v1`, through `registerPublic`. One env is built per server and shared by both.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { realTimer } from '../live/module.js';
import type { HooksEnv, SetTimer } from './env.js';
import { CatchBuckets } from './rate-limit.js';
import { captureIdFactory } from './repo.js';
import { manageRoutes } from './routes/manage.js';
import { publicRoutes } from './routes/public.js';
import { hooksMetaOf, hooksSettings } from './settings.js';
import { CaptureSweeper } from './sweep.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const HOOKS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/webhook-capture/', import.meta.url));

export interface HooksOptions {
  /** Injected clock: `received_at`, the buckets' refill and the sweep's cutoff. */
  readonly now?: () => Date;
  /** Injected timers: the response delay and the sweep interval. Tests fire them by hand. */
  readonly setTimer?: SetTimer;
}

export function hooksModule(options: HooksOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const setTimer = options.setTimer ?? realTimer;
  let webhooks: HooksEnv | undefined;
  const envFor = (ctx: ServerContext): HooksEnv => {
    if (webhooks === undefined) {
      const settings = hooksSettings(ctx.config);
      webhooks = {
        ctx,
        settings,
        now,
        setTimer,
        buckets: new CatchBuckets({
          ratePerSecond: settings.ratePerSecond,
          burst: settings.burst,
          now: () => now().getTime(),
        }),
        newCaptureId: captureIdFactory(),
      };
    }
    return webhooks;
  };

  return {
    name: 'webhook-capture',
    migrationsDir: HOOKS_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const env = envFor(ctx);
      ctx.meta.setHooks(hooksMetaOf(env.settings));
      // §3.4: runs whether or not the feature is on, so switching it off never keeps old captures.
      const sweeper = new CaptureSweeper({
        db: ctx.db,
        maxAgeDays: env.settings.maxAgeDays,
        now,
        setTimer,
        log: ctx.log,
      });
      sweeper.start();
      // Before `startServer` drains and closes the pool (host spec §3.7): a batch under way finishes.
      app.addHook('onClose', () => sweeper.stop());
      // §3.7: switched off, the management routes do not exist either (the sweep above still runs).
      if (env.settings.enabled) manageRoutes(env)(app);
      await Promise.resolve();
    },

    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      const env = envFor(ctx);
      // §3.7: switched off, the public route does not exist; `/hooks/…` falls to the root's 404.
      if (env.settings.enabled) publicRoutes(env)(root);
      await Promise.resolve();
    },
  };
}
