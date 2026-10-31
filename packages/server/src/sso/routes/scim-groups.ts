/** `/api/v1/scim-groups` (saml-scim spec §3.6): server admins only, behind the `sso-provisioning` feature. */
import {
  identityIdParamsSchema,
  scimGroupLinkRequestSchema,
  scimGroupSummarySchema,
  scimGroupsResponseSchema,
  type ScimGroupLinkRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { auditSource } from '../../context.js';
import { requireServerAdmin } from '../../identity/guard.js';
import { jsonSchema } from '../../schema.js';
import type { SsoEnv } from '../env.js';
import { listGroupSummaries, setGroupLink } from '../group-links.js';

export const scimGroupRoutes =
  (env: SsoEnv) =>
  (app: FastifyInstance): void => {
    const preHandler = [requireServerAdmin, env.ctx.license.requireFeature('sso-provisioning')];
    const params = jsonSchema(identityIdParamsSchema, { io: 'input' });

    app.get(
      '/scim-groups',
      { preHandler, schema: { response: { 200: jsonSchema(scimGroupsResponseSchema) } } },
      (request) => listGroupSummaries(env, request.tenant),
    );

    app.put(
      '/scim-groups/:id/team',
      {
        preHandler,
        schema: {
          params,
          body: jsonSchema(scimGroupLinkRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(scimGroupSummarySchema) },
        },
      },
      (request) => {
        const { id } = request.params as { readonly id: string };
        const { teamId } = request.body as ScimGroupLinkRequest;
        return setGroupLink(env, request.tenant, id, teamId, auditSource(request), request.log);
      },
    );

    app.delete(
      '/scim-groups/:id/team',
      { preHandler, schema: { params, response: { 200: jsonSchema(scimGroupSummarySchema) } } },
      (request) =>
        setGroupLink(
          env,
          request.tenant,
          (request.params as { readonly id: string }).id,
          null,
          auditSource(request),
          request.log,
        ),
    );
  };
