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
import { authenticate } from './guard.js';
import type { OidcProvider } from './oidc.js';
import { RateLimiter } from './rate-limit.js';
import { authLocalRoutes } from './routes/auth-local.js';
import { meRoutes } from './routes/me.js';
import { sweepExpired } from './sessions.js';

export const IDENTITY_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/identity/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

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
    register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
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
      app.addHook('onRequest', authenticate(env));
      authLocalRoutes(env)(app);
      meRoutes(env)(app);
      // Tasks 6–7 register invitations, users, the invite page and OIDC here.

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepExpired(env).catch((error: unknown) => ctx.log.warn({ err: error }, 'identity sweep failed'));
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
