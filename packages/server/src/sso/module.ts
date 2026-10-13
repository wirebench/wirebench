/**
 * The `sso` ServerModule (saml-scim spec §5): SAML sign-in and SCIM provisioning, behind the
 * `sso-provisioning` licence feature. Registered last: its tables name `teams` and `audit_events`, so its
 * migration follows theirs, and its routes sit in the shared `/api/v1` scope behind identity's guard. It
 * reuses identity's sessions and linking rules rather than keeping its own.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import * as repo from './repo.js';

export const SSO_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/sso/', import.meta.url));

const DAY_MS = 24 * 60 * 60 * 1000;

export interface SsoOptions {
  /** Injected clock for expiry tests. */
  readonly now?: () => Date;
  /** How often expired SAML flows are swept; `0` disables the timer (tests). Default daily. */
  readonly sweepIntervalMs?: number;
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
      await Promise.resolve();
    },
  };
}
