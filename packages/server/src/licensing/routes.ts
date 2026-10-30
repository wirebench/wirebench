// packages/server/src/licensing/routes.ts
/** `GET`, `PUT` and `DELETE /license` (licensing spec §3.6): server admins only. */
import {
  licenseInstallRequestSchema,
  licenseStateSchema,
  type LicenseInstallRequest,
  type LicenseState,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce, tenantOf, type LicenseService, type ServerHooks } from '../context.js';
import { requireServerAdmin } from '../identity/guard.js';
import { rateLimit, type RateLimiter } from '../identity/rate-limit.js';
import { jsonSchema } from '../schema.js';
import { installLicense, removeLicense, type LicenseEnv } from './service.js';

export interface LicenseRoutesEnv extends LicenseEnv {
  readonly service: LicenseService;
  readonly hooks: ServerHooks;
  /** PUT carries a signature check, so it is rate-limited as identity's attempts are (§3.6). */
  readonly limiter: RateLimiter;
}

export const licenseRoutes =
  (env: LicenseRoutesEnv) =>
  (app: FastifyInstance): void => {
    const state = jsonSchema(licenseStateSchema);

    app.get(
      '/license',
      { preHandler: requireServerAdmin, schema: { response: { 200: state } } },
      (request): Promise<LicenseState> => env.service.state(request.tenant),
    );

    app.put(
      '/license',
      {
        preHandler: [
          requireServerAdmin,
          rateLimit(env, (request) => [`${request.tenant.tenantId}:license:${request.caller?.id ?? request.ip}`]),
        ],
        schema: { body: jsonSchema(licenseInstallRequestSchema, { io: 'input' }), response: { 200: state } },
      },
      async (request): Promise<LicenseState> => {
        const { license } = request.body as LicenseInstallRequest;
        const changed = await installLicense(env, request.tenant, license, request.caller!.id);
        // The text is never logged; the id is (§6).
        request.log.info({ licenseId: changed.licenseId }, 'license installed');
        announce(env.hooks.licenseChanged, { ...changed, ...tenantOf(request) }, request.log);
        return env.service.state(request.tenant);
      },
    );

    app.delete('/license', { preHandler: requireServerAdmin }, async (request, reply) => {
      const changed = await removeLicense(env, request.tenant, request.caller!.id);
      if (changed !== undefined) {
        request.log.info({ licenseId: changed.licenseId }, 'license removed');
        announce(env.hooks.licenseChanged, { ...changed, ...tenantOf(request) }, request.log);
      }
      return reply.code(204).send();
    });
  };
