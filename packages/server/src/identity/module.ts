/**
 * The `identity` ServerModule (spec §5.1). Registration order inside `register` matters: OIDC
 * discovery runs first (a failure is a start-up failure, exit 2 via serve.ts), then the
 * `onRequest` hook, then the routes that read `request.caller`. The module is mounted into the
 * shared /api/v1 scope, so the hook also reaches `teams-access` and `server-sync` registered
 * after it. The invitation page is served at the root through `registerPublic`.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings, type IdentityEnv } from './env.js';
import { authenticate } from './guard.js';
import { discoverOidc, type OidcProvider } from './oidc.js';
import { RateLimiter } from './rate-limit.js';
import { authLocalRoutes } from './routes/auth-local.js';
import { authOidcRoutes } from './routes/auth-oidc.js';
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
  /** A provider instead of discovery — a fake in tests. */
  readonly provider?: OidcProvider;
  /** How often expired tokens and flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
}

export function identityModule(options: IdentityOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  let env: IdentityEnv | undefined;
  const envFor = (ctx: ServerContext, provider: OidcProvider | undefined): IdentityEnv =>
    (env ??= {
      ctx,
      settings: identitySettings(ctx.config),
      now,
      limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
      provider,
    });

  return {
    name: 'identity',
    migrationsDir: IDENTITY_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      let provider = options.provider;
      if (settings.oidc !== undefined && provider === undefined) {
        provider = await discoverOidc({
          issuer: settings.oidc.issuer,
          clientId: ctx.config.oidcClientId!,
          clientSecret: ctx.config.oidcClientSecret!,
          scopes: ctx.config.oidcScopes,
          allowInsecure: ctx.config.allowInsecurePublicUrl,
        });
      }
      const identity = envFor(ctx, provider);
      ctx.meta.setSignInMethods({
        local: settings.local,
        oidc: settings.oidc !== undefined,
        ...(settings.oidc !== undefined ? { oidcDisplayName: settings.oidc.displayName } : {}),
      });
      ctx.meta.addCapability('identity');

      app.addHook('onRequest', authenticate(identity));
      authLocalRoutes(identity)(app);
      authOidcRoutes(identity)(app);
      meRoutes(identity)(app);
      invitationRoutes(identity)(app);
      userRoutes(identity)(app);

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepExpired(identity).catch((error: unknown) => ctx.log.warn({ err: error }, 'identity sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
    },

    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      invitePageRoutes(envFor(ctx, options.provider))(root);
      await Promise.resolve();
    },
  };
}
