/**
 * The `agent` ServerModule (hosted edition spec §18.2): pairing a user's local agent with this server, and
 * the single-use nonces a browser tab hands that agent. It registers nothing unless
 * `WIREBENCH_SERVER_BROWSER_CLIENT` is on (only a browser tab has an agent to pair), but its migration
 * always runs, as every module's does, so the version list stays contiguous.
 *
 * It comes after `host`. It announces `agentUnpaired` for the server host to drop a pairing from its view;
 * nothing listens yet (Part B's server host will).
 * Expired codes and nonces are swept daily, like identity's flows, in each tenant's unit through the job loop.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import * as repo from './repo.js';
import { agentRoutes } from './routes.js';

export const AGENT_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/agent/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;
/** The sweep's name in the job loop's log lines. */
export const AGENT_SWEEP_JOB = 'agent-sweep';

export interface AgentModuleOptions {
  /** Injected clock for expiry and timestamp tests. */
  readonly now?: () => Date;
  /** How often expired codes and nonces are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
}

/** Deletes one tenant's expired pairing codes and nonces. */
export function sweepAgent(db: TenantQuerier, now: Date): Promise<{ codes: number; nonces: number }> {
  return repo.deleteExpired(db, now);
}

export function agentModule(options: AgentModuleOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'agent',
    migrationsDir: AGENT_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      if (!ctx.config.browserClient) return;
      // loadConfig refuses the browser client without the key; checked again so the type knows it.
      if (ctx.config.secretsKey === undefined) throw new Error('the agent module needs WIREBENCH_SERVER_SECRETS_KEY');
      await agentRoutes({ ctx, now, secretsKey: ctx.config.secretsKey })(app);
      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          ctx.tenancy
            .forEachTenant(
              AGENT_SWEEP_JOB,
              async (tx) => {
                await sweepAgent(tx, now());
              },
              ctx.log,
            )
            .catch((error: unknown) => ctx.log.warn({ err: error }, 'agent sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
    },
  };
}
