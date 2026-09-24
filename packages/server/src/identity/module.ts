/**
 * The `identity` ServerModule (spec §5.1). Registration order inside `register` matters: the
 * `onRequest` hook must exist before any route that reads `request.caller`, and the module is
 * mounted into the shared /api/v1 scope, so the hook also reaches `teams-access` and
 * `server-sync` registered after it.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings, type IdentityEnv } from './env.js';
import type { OidcProvider } from './oidc.js';
import { RateLimiter } from './rate-limit.js';

export const IDENTITY_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/identity/', import.meta.url));

export interface IdentityOptions {
  /** Injected clock for expiry tests. */
  readonly now?: () => Date;
  /** A provider instead of discovery — the fake issuer in tests. */
  readonly provider?: OidcProvider;
  /** How often expired tokens and flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
}

export function identityModule(options: IdentityOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'identity',
    migrationsDir: IDENTITY_MIGRATIONS_DIR,
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      const env: IdentityEnv = {
        ctx,
        settings,
        now,
        limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
        provider: options.provider,
      };
      ctx.meta.setSignInMethods({
        local: settings.local,
        oidc: settings.oidc !== undefined,
        ...(settings.oidc !== undefined ? { oidcDisplayName: settings.oidc.displayName } : {}),
      });
      ctx.meta.addCapability('identity');
      void env; // Tasks 4–7 add the hook, the routes, discovery and the sweep here.
      await Promise.resolve();
    },
  };
}
