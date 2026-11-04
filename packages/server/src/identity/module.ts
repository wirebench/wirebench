/**
 * The `identity` ServerModule (spec §5.1). Registration order inside `register` matters: OIDC
 * discovery runs first (a failure is a start-up failure, exit 2 via serve.ts), then the
 * `onRequest` hook, then the routes that read `request.caller`. The module is mounted into the
 * shared /api/v1 scope, so the hook also reaches `teams-access` and `server-sync` registered
 * after it. The invitation page, and the browser's sign-in page when the browser client is on, are
 * served at the root through `registerPublic`.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { identitySettings, type IdentityEnv } from './env.js';
import { authenticate, type BearerFallback } from './guard.js';
import { discoverOidc, type OidcProvider, type OidcSettings } from './oidc.js';
import { TenantRateLimiter } from './rate-limit.js';
import { authLocalRoutes } from './routes/auth-local.js';
import { authOidcRoutes } from './routes/auth-oidc.js';
import { browserSignInRoutes } from './routes/browser-sign-in.js';
import { invitationRoutes } from './routes/invitations.js';
import { invitePageRoutes } from './routes/invite-page.js';
import { meRoutes } from './routes/me.js';
import { userRoutes } from './routes/users.js';
import { settingsRoutes } from '../settings/routes.js';
import { sweepExpired } from './sessions.js';
import { TenantOidcProviders } from './tenant-oidc.js';
import type { TenantScope } from '../tenancy/scope.js';

export const IDENTITY_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/identity/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

export interface IdentityOptions {
  /** Injected clock for expiry tests. */
  readonly now?: () => Date;
  /** A provider instead of discovery — a fake in tests. */
  readonly provider?: OidcProvider;
  /** How often expired tokens and flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
  /**
   * The egress rule a hosted tenant's discovery runs under: `ctx.egress` unless a test's fake issuer, on loopback,
   * needs `'unchecked'` (the rule always refuses loopback).
   */
  readonly oidcEgress?: 'unchecked';
}

export function identityModule(options: IdentityOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  let env: IdentityEnv | undefined;
  const envFor = (ctx: ServerContext): IdentityEnv => {
    if (env !== undefined) return env;
    const settings = identitySettings(ctx.config);
    let providerFor: IdentityEnv['providerFor'];
    if (ctx.config.mode === 'hosted') {
      // Each tenant's own client, from its settings (spec §22.12); the environment's provider is never used here.
      const tenants = new TenantOidcProviders({
        settings: ctx.settings,
        discover: (input: OidcSettings) => discoverOidc(input),
        allowInsecure: ctx.config.allowInsecurePublicUrl,
        egress: options.oidcEgress ?? ctx.egress,
        now: () => now().getTime(),
      });
      providerFor = (scope) => tenants.providerFor(scope);
    } else {
      providerFor = () => Promise.resolve(staticProvider);
    }
    env = {
      ctx,
      settings,
      now,
      limiter: new TenantRateLimiter({
        name: 'identity',
        capacity: 10,
        refillPerMs: 10 / 60_000,
        db: ctx.tenancy.db,
        ...(options.now !== undefined ? { now: () => now().getTime() } : {}),
      }),
      providerFor,
      ...(ctx.config.mode === 'hosted'
        ? { oidcOffered: async (scope: TenantScope) => (await ctx.settings.of(scope, 'oidc')) !== undefined }
        : {}),
    };
    return env;
  };
  /** The environment's provider, self-hosted: discovered once at registration. */
  let staticProvider: OidcProvider | undefined;

  return {
    name: 'identity',
    migrationsDir: IDENTITY_MIGRATIONS_DIR,

    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const settings = identitySettings(ctx.config);
      // Self-hosted, the environment's provider (`settings.oidc` is never set in hosted mode, spec §22.1).
      if (settings.oidc !== undefined) {
        staticProvider =
          options.provider ??
          (await discoverOidc({
            issuer: settings.oidc.issuer,
            clientId: ctx.config.oidcClientId!,
            clientSecret: ctx.config.oidcClientSecret!,
            scopes: ctx.config.oidcScopes,
            allowInsecure: ctx.config.allowInsecurePublicUrl,
          }));
      }
      const identity = envFor(ctx);
      ctx.meta.setSignInMethods({
        local: settings.local,
        oidc: settings.oidc !== undefined,
        ...(settings.oidc !== undefined ? { oidcDisplayName: settings.oidc.displayName } : {}),
      });
      // Hosted, what a tenant offers is its own setting, read per request (spec §22.12).
      if (ctx.config.mode === 'hosted') {
        ctx.meta.addSignInResolver(async (scope) => {
          const oidc = await ctx.settings.of(scope, 'oidc');
          return oidc === undefined ? { oidc: false } : { oidc: true, oidcDisplayName: oidc.displayName };
        });
      }
      ctx.meta.addCapability('identity');

      const fallbacks: BearerFallback[] = [];
      // In the shared `/api/v1` scope, so a module registered later (ci-tokens) can add its own.
      app.decorate('bearerFallbacks', fallbacks);
      app.addHook('onRequest', authenticate(identity, fallbacks));
      authLocalRoutes(identity)(app);
      authOidcRoutes(identity)(app);
      meRoutes(identity)(app);
      invitationRoutes(identity)(app);
      userRoutes(identity)(app);
      // Spec §22.12: a tenant's settings, for its server admins; behind identity's guard, as the user routes are.
      settingsRoutes(ctx, {
        allowInsecure: ctx.config.allowInsecurePublicUrl,
        egress: options.oidcEgress ?? ctx.egress,
      })(app);

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          // One unit per tenant; a tenant's own failure is logged by the job loop with its id.
          sweepExpired(identity).catch((error: unknown) => ctx.log.warn({ err: error }, 'identity sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
    },

    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      const identity = envFor(ctx);
      invitePageRoutes(identity)(root);
      // Hosted spec §17.2: the browser's sign-in page and flows, only when the operator asked for them.
      if (ctx.config.browserClient) browserSignInRoutes(identity)(root);
      await Promise.resolve();
    },
  };
}
