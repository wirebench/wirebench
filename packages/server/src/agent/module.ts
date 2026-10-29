/**
 * The `agent` ServerModule (hosted edition spec §18.2): pairing a user's local agent with this server, and
 * the single-use nonces a browser tab hands that agent. It registers nothing unless
 * `WIREBENCH_SERVER_BROWSER_CLIENT` is on (only a browser tab has an agent to pair), but its migration
 * always runs, as every module's does, so the version list stays contiguous.
 *
 * It comes after `host`, whose server host listens to `agentUnpaired` to drop a pairing from its view.
 * Expired codes and nonces are swept daily, like identity's flows.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { Querier, ServerContext, ServerModule } from '../context.js';
import * as repo from './repo.js';
import { agentRoutes } from './routes.js';

export const AGENT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/agent/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

export interface AgentModuleOptions {
  /** Injected clock for expiry and timestamp tests. */
  readonly now?: () => Date;
  /** How often expired codes and nonces are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
}

/** Deletes expired pairing codes and nonces. */
export function sweepAgent(db: Querier, now: Date): Promise<{ codes: number; nonces: number }> {
  return repo.deleteExpired(db, now);
}

export function agentModule(options: AgentModuleOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'agent',
    migrationsDir: AGENT_MIGRATIONS_DIR,

    register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      if (!ctx.config.browserClient) return Promise.resolve();
      agentRoutes({ ctx, now })(app);
      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepAgent(ctx.db, now()).catch((error: unknown) => ctx.log.warn({ err: error }, 'agent sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
      return Promise.resolve();
    },
  };
}
