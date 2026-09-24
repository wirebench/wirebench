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
import { invitationRoutes } from './routes/invitations.js';
import { invitePageRoutes } from './routes/invite-page.js';
import { meRoutes } from './routes/me.js';
import { userRoutes } from './routes/users.js';
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
  // `register` and `registerPublic` need the same `IdentityEnv`; built once, on first use, from
  // whichever hook runs first (registration order between the two is not guaranteed).
  let env: IdentityEnv | undefined;
  const envFor = (ctx: ServerContext): IdentityEnv =>
    (env ??= {
      ctx,
      settings: identitySettings(ctx.config),
      now,
      limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
      provider: options.provider,
    });
  return {
    name: 'identity',
    migrationsDir: IDENTITY_MIGRATIONS_DIR,
    register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const identityEnv = envFor(ctx);
      ctx.meta.setSignInMethods({
        local: identityEnv.settings.local,
        oidc: identityEnv.settings.oidc !== undefined,
        ...(identityEnv.settings.oidc !== undefined ? { oidcDisplayName: identityEnv.settings.oidc.displayName } : {}),
      });
      ctx.meta.addCapability('identity');
      app.addHook('onRequest', authenticate(identityEnv));
      authLocalRoutes(identityEnv)(app);
      meRoutes(identityEnv)(app);
      invitationRoutes(identityEnv)(app);
      userRoutes(identityEnv)(app);
      // Task 7 registers the OIDC routes here.

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepExpired(identityEnv).catch((error: unknown) => ctx.log.warn({ err: error }, 'identity sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
      return Promise.resolve();
    },
    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      invitePageRoutes(envFor(ctx))(root);
      await Promise.resolve();
    },
  };
}
