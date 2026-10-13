/**
 * The `sso` ServerModule (saml-scim spec §5): SAML sign-in and SCIM provisioning, behind the
 * `sso-provisioning` licence feature. Registered last: its tables name `teams` and `audit_events`, so its
 * migration follows theirs, and its routes sit in the shared `/api/v1` scope behind identity's guard. It
 * reuses identity's sessions and linking rules rather than keeping its own.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { RateLimiter } from '../identity/rate-limit.js';
import { samlSettings, ssoUrls, type SsoEnv } from './env.js';
import * as repo from './repo.js';
import { authSamlRoutes } from './routes/auth-saml.js';
import { scimTokenRoutes } from './routes/scim-tokens.js';
import { loadIdpMetadata, type IdpMetadata } from './saml-metadata.js';
import { samlProvider } from './saml.js';

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

/** The daily sweep: SAML flows nobody finished. */
export async function sweepSso(db: ServerContext['db'], now: Date): Promise<void> {
  await repo.deleteExpiredSamlFlows(db, now);
}

export function ssoModule(options: SsoOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  return {
    name: 'sso',
    migrationsDir: SSO_MIGRATIONS_DIR,
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const urls = ssoUrls(ctx.config.publicUrl);
      const settings = samlSettings(ctx.config);
      let saml: SsoEnv['saml'];
      if (settings !== undefined) {
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
      }
      const env: SsoEnv = {
        ctx,
        now,
        limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
        urls,
        saml,
      };
      authSamlRoutes(env)(app);
      scimTokenRoutes(env)(app);

      const interval = options.sweepIntervalMs ?? DAY_MS;
      if (interval > 0) {
        const timer = setInterval(() => {
          sweepSso(ctx.db, now()).catch((error: unknown) => ctx.log.warn({ err: error }, 'sso sweep failed'));
        }, interval);
        timer.unref();
        app.addHook('onClose', () => {
          clearInterval(timer);
        });
      }
    },
  };
}
