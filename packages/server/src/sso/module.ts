/**
 * The `sso` ServerModule (saml-scim spec §5): SAML sign-in and SCIM provisioning, behind the
 * `sso-provisioning` licence feature. Registered last: its tables name `teams` and `audit_events`, so its
 * migration follows theirs, and its routes sit in the shared `/api/v1` scope behind identity's guard. It
 * reuses identity's sessions and linking rules rather than keeping its own.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { TenantRateLimiter } from '../identity/rate-limit.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { primaryUrl, urlWithoutScope } from '../tenancy/urls.js';
import type { ScopeSource } from '../tenancy/urls.js';
import { samlSettings, ssoUrls, type SamlState, type SsoEnv, type SsoUrls } from './env.js';
import * as repo from './repo.js';
import { authSamlRoutes, browserSamlStartRoutes } from './routes/auth-saml.js';
import { scimGroupRoutes } from './routes/scim-groups.js';
import { scimTokenRoutes } from './routes/scim-tokens.js';
import { scimPlugin } from './scim/plugin.js';
import { loadIdpMetadata, type IdpMetadata } from './saml-metadata.js';
import { samlProvider } from './saml.js';
import { TenantSamlProviders } from './tenant-saml.js';

export const SSO_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/sso/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SsoOptions {
  /** Injected clock for expiry tests. */
  readonly now?: () => Date;
  /** How often expired SAML flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
  /** IdP metadata instead of reading `WIREBENCH_SERVER_SAML_IDP_METADATA` (tests). */
  readonly metadata?: IdpMetadata;
}

/** The sweep's name in the job loop's log lines. */
export const SSO_SWEEP_JOB = 'sso-sweep';

/** The daily sweep: one tenant's SAML flows nobody finished. */
export async function sweepSso(db: TenantQuerier, now: Date): Promise<void> {
  await repo.deleteExpiredSamlFlows(db, now);
}

export function ssoModule(options: SsoOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  /** Built in `register`; the SCIM scope, mounted at the root afterwards, shares it. */
  let shared: SsoEnv | undefined;
  return {
    name: 'sso',
    migrationsDir: SSO_MIGRATIONS_DIR,
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      // Self-hosted, the SAML provider is the server-wide one, configured from the environment: the default
      // tenant's. Hosted mode has no server-wide one (spec §22.1); each tenant's comes from its settings.
      const serverWide = urlWithoutScope(ctx.config);
      const settings = serverWide === undefined ? undefined : samlSettings(ctx.config);
      let saml: SamlState | undefined;
      if (settings !== undefined && serverWide !== undefined) {
        const urls = ssoUrls(serverWide);
        // Read once at start-up; a failure is a start-up failure (exit 2 through serve.ts).
        const metadata =
          options.metadata ??
          (await loadIdpMetadata(settings.metadataSource, { allowInsecure: ctx.config.allowInsecurePublicUrl }));
        saml = {
          provider: samlProvider(metadata, {
            entityId: urls.entityId,
            acsUrl: urls.acsUrl,
            clockSkewMs: settings.clockSkewMs,
          }),
          claims: {
            ...(settings.emailAttribute !== undefined ? { emailAttribute: settings.emailAttribute } : {}),
            ...(settings.nameAttribute !== undefined ? { nameAttribute: settings.nameAttribute } : {}),
          },
        };
        ctx.meta.setSignInMethods({ saml: true, samlDisplayName: settings.displayName });
        // §3.1: what an operator gives the IdP, without opening the app.
        ctx.log.info(
          {
            idpEntityId: metadata.entityId,
            entityId: urls.entityId,
            acsUrl: urls.acsUrl,
            ...(ctx.config.browserClient ? { browserAcsUrl: urls.browserAcsUrl } : {}),
            scimBaseUrl: urls.scimBaseUrl,
          },
          'saml sign-in on',
        );
      }
      const urlsFor = (of: ScopeSource): SsoUrls => ssoUrls(primaryUrl(ctx.config, of));
      const tenants =
        ctx.config.mode === 'hosted'
          ? new TenantSamlProviders({ settings: ctx.settings, urlsFor, log: () => ctx.log })
          : undefined;
      if (tenants !== undefined) {
        ctx.meta.addSignInResolver(async (scope) => {
          const own = await ctx.settings.of(scope, 'saml');
          return own === undefined ? { saml: false } : { saml: true, samlDisplayName: own.displayName };
        });
      }
      const env: SsoEnv = {
        ctx,
        now,
        limiter: new TenantRateLimiter({
          name: 'sso',
          capacity: 10,
          refillPerMs: 10 / 60_000,
          db: ctx.tenancy.db,
          ...(options.now !== undefined ? { now: () => now().getTime() } : {}),
        }),
        urlsFor,
        samlFor: tenants === undefined ? () => Promise.resolve(saml) : (scope) => tenants.samlFor(scope),
      };
      shared = env;
      // Every mode serves them (spec §22.12): in hosted mode each tenant's SAML is its own setting, and a tenant
      // without one answers as a server without SAML. SCIM is a tenant's own tokens and rows either way.
      authSamlRoutes(env)(app);
      scimTokenRoutes(env)(app);
      scimGroupRoutes(env)(app);

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          ctx.tenancy
            .forEachTenant(SSO_SWEEP_JOB, (tx) => sweepSso(tx, now()), ctx.log)
            .catch((error: unknown) => ctx.log.warn({ err: error }, 'sso sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
    },

    async registerPublic(root: FastifyInstance, ctx: ServerContext): Promise<void> {
      // Beside `/api/v1`, never inside it: a SCIM token must not reach the device-token routes (§6.2).
      await root.register(scimPlugin(shared!), { prefix: '/scim/v2' });
      // Hosted spec §17.2: the browser's SAML start sits beside identity's `/sign-in` page.
      if (ctx.config.browserClient) browserSamlStartRoutes(shared!)(root);
    },
  };
}
