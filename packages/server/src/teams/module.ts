/**
 * The `teams-access` ServerModule (spec §5.1). Registered after identity in the shared /api/v1
 * scope, so identity's `onRequest` hook has set `request.caller` before any route here runs.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings } from '../identity/env.js';
import type { TeamsEnv } from './env.js';

export const TEAMS_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/teams-access/', import.meta.url));

export interface TeamsOptions {
  /** Injected clock, shared with identity's in tests. */
  readonly now?: () => Date;
}

export function teamsModule(options: TeamsOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'teams-access',
    migrationsDir: TEAMS_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const env: TeamsEnv = { ctx, now, invitations: { ctx, settings: identitySettings(ctx.config), now } };
      ctx.meta.addCapability('teams');
      // Tasks 6–8 register their routes and the invitation hook here, replacing these two lines.
      void app;
      void env;
      await Promise.resolve();
    },
  };
}
