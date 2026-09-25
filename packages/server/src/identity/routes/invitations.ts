import {
  identityIdParamsSchema,
  invitationAcceptRequestSchema,
  invitationCreatedSchema,
  invitationCreateRequestSchema,
  invitationLookupQuerySchema,
  invitationLookupResponseSchema,
  invitationsResponseSchema,
  signInResponseSchema,
  type InvitationAcceptRequest,
  type InvitationCreateRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { IdentityEnv } from '../env.js';
import { notFound } from '../errors.js';
import { requireServerAdmin } from '../guard.js';
import {
  acceptInvitation,
  createInvitation,
  invitationSummary,
  lookupInvitation,
  revokeOpenInvitation,
} from '../invitations.js';
import { ipKey, rateLimit } from '../rate-limit.js';
import * as repo from '../repo.js';

export const invitationRoutes =
  (env: IdentityEnv) =>
  (app: FastifyInstance): void => {
    app.post(
      '/invitations',
      {
        preHandler: requireServerAdmin,
        schema: {
          body: jsonSchema(invitationCreateRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(invitationCreatedSchema) },
        },
      },
      async (request, reply) => {
        const body = request.body as InvitationCreateRequest;
        const created = await createInvitation(env, {
          email: body.email,
          serverAdmin: body.serverAdmin ?? false,
          createdBy: request.caller!.id,
        });
        return reply.code(201).send(created);
      },
    );

    app.get(
      '/invitations',
      { preHandler: requireServerAdmin, schema: { response: { 200: jsonSchema(invitationsResponseSchema) } } },
      async () => (await repo.listInvitations(env.ctx.db)).map(invitationSummary),
    );

    app.delete(
      '/invitations/:id',
      { preHandler: requireServerAdmin, schema: { params: jsonSchema(identityIdParamsSchema, { io: 'input' }) } },
      async (request, reply) => {
        const { id } = request.params as { id: string };
        if (!(await revokeOpenInvitation(env, id))) throw notFound('Invitation');
        return reply.code(204).send();
      },
    );

    app.get(
      '/invitations/lookup',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: {
          querystring: jsonSchema(invitationLookupQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(invitationLookupResponseSchema) },
        },
      },
      async (request) => lookupInvitation(env, (request.query as { secret: string }).secret),
    );

    app.post(
      '/invitations/accept',
      {
        preHandler: [rateLimit(env, (request) => [ipKey(request)])],
        schema: {
          body: jsonSchema(invitationAcceptRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(signInResponseSchema) },
        },
      },
      async (request, reply) =>
        reply.code(201).send(await acceptInvitation(env, request.body as InvitationAcceptRequest)),
    );
  };
