// packages/server/src/licensing/module.ts
/**
 * The `licensing` ServerModule (licensing spec §5.1). Registered right after identity, so its routes
 * sit behind identity's `onRequest` guard. It replaces the host's permissive `ctx.license`; identity's
 * handlers read `ctx.license` at request time, so the order of the two matters only for routes.
 */
import type { KeyObject } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import type { FastifyInstance } from 'fastify';
import type { ServerContext, ServerModule } from '../context.js';
import { RateLimiter } from '../identity/rate-limit.js';
import { PRODUCTION_PUBLIC_KEYS } from './keys.js';
import * as repo from './repo.js';
import { licenseRoutes } from './routes.js';
import { createLicenseService } from './service.js';

export const LICENSING_MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/licensing/', import.meta.url));

export interface LicensingOptions {
  /** Injected clock: expiry, grace and `installed_at`. */
  readonly now?: () => Date;
  /** Test keys. Production passes nothing and gets the compiled-in keys; there is no configuration for this. */
  readonly publicKeys?: readonly KeyObject[];
}

export function licensingModule(options: LicensingOptions = {}): ServerModule {
  const now = options.now ?? (() => new Date());
  const publicKeys = options.publicKeys ?? PRODUCTION_PUBLIC_KEYS;
  return {
    name: 'licensing',
    migrationsDir: LICENSING_MIGRATIONS_DIR,
    async register(app: FastifyInstance, ctx: ServerContext): Promise<void> {
      const serverId = await repo.serverId(ctx.db);
      const service = createLicenseService({ db: ctx.db, publicKeys, now, serverId });
      ctx.license = service;
      licenseRoutes({
        db: ctx.db,
        publicKeys,
        now,
        serverId,
        service,
        hooks: ctx.hooks,
        limiter: new RateLimiter({ capacity: 10, refillPerMs: 10 / 60_000, now: () => now().getTime() }),
      })(app);
    },
  };
}
