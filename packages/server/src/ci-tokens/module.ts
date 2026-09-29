/**
 * The `ci-tokens` ServerModule (callback-assertion spec §3): read-only, workspace-scoped bearer
 * tokens for CI. It is registered after webhook-capture: the routes a CI token may call are that
 * module's, and its own management routes use teams-access's role guard.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { ciBearer } from './principal.js';
import { ciRoutes } from './routes.js';

/** Beside `dist/`, like every module's migrations (`ServerModule.migrationsDir`). */
export const CI_TOKENS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/ci-tokens/', import.meta.url));

export interface CiTokensOptions {
  /** Injected clock: `created_at`, `revoked_at`, `last_used_at`. */
  readonly now?: () => Date;
}

export function ciTokensModule(options: CiTokensOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'ci-tokens',
    migrationsDir: CI_TOKENS_MIGRATIONS_DIR,
    // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      ctx.meta.addCapability('ci-tokens');
      app.bearerFallbacks.push(ciBearer({ db: ctx.db, now }));
      ciRoutes({ db: ctx.db, now })(app);
    },
  };
}
