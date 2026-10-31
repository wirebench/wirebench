/** `/api/v1/scim-tokens` (saml-scim spec §3.4): server admins only, behind the `sso-provisioning` feature. */
import { z } from 'zod';
import {
  identityIdParamsSchema,
  scimTokenCreatedSchema,
  scimTokensResponseSchema,
  type ScimTokenSummary,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource } from '../../context.js';
import { requireServerAdmin } from '../../identity/guard.js';
import { jsonSchema } from '../../schema.js';
import type { SsoEnv } from '../env.js';
import * as repo from '../repo.js';
import { createScimToken, revokeScimToken, scimTokenSummary } from '../scim-tokens.js';

/** Bounded loosely: the name is trimmed before its 1–64 check, so padding never refuses a valid name. */
const createBodySchema = z.object({ name: z.string().max(1024) });

export const scimTokenRoutes =
  (env: SsoEnv) =>
  (app: FastifyInstance): void => {
    const preHandler = [requireServerAdmin, env.ctx.license.requireFeature('sso-provisioning')];

    app.post(
      '/scim-tokens',
      {
        preHandler,
        schema: {
          body: jsonSchema(createBodySchema, { io: 'input' }),
          response: { 201: jsonSchema(scimTokenCreatedSchema) },
        },
      },
      async (request, reply) => {
        const { name } = request.body as z.infer<typeof createBodySchema>;
        return reply
          .code(201)
          .send(await createScimToken(env, request.tenant, name, request.caller!.id, auditSource(request)));
      },
    );

    app.get(
      '/scim-tokens',
      { preHandler, schema: { response: { 200: jsonSchema(scimTokensResponseSchema) } } },
      async (request): Promise<ScimTokenSummary[]> =>
        (await repo.listScimTokens(env.ctx.tenancy.db(request.tenant))).map(scimTokenSummary),
    );

    app.delete(
      '/scim-tokens/:id',
      { preHandler, schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const { id } = request.params as { readonly id: string };
        await revokeScimToken(env, request.tenant, id, auditSource(request));
        return reply.code(204).send();
      },
    );
  };
