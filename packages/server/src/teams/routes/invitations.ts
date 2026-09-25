/**
 * `/teams/:teamId/invitations` (spec §3.2) and the hook that keeps a team invitation's promise
 * (§3.4). The invitation itself is identity's; this module adds the team and the role through
 * `createInvitation`'s `attach`, in the same transaction.
 */
import {
  teamInvitationCreatedSchema,
  teamInvitationCreateRequestSchema,
  teamInvitationParamsSchema,
  teamInvitationsResponseSchema,
  teamParamsSchema,
  WirebenchError,
  type InvitationCreated,
  type TeamInvitationCreateRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { InvitationAcceptedHook } from '../../context.js';
import { createInvitation, revokeOpenInvitation } from '../../identity/invitations.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { invitationNotFound, userExistsInvite } from '../errors.js';
import * as repo from '../repo.js';
import { requireTeamRole } from '../roles.js';

/**
 * §3.4: runs inside identity's accepting transaction. No `team_invitations` row means a plain
 * server invitation, or a team deleted since (its row went with it): nothing to add.
 */
export function addInvitedMember(now: () => Date): InvitationAcceptedHook {
  return async (tx, accepted) => {
    const invited = await repo.teamInvitationOf(tx, accepted.invitationId);
    if (invited === undefined) return;
    await repo.insertMember(tx, { teamId: invited.teamId, userId: accepted.userId, role: invited.role, at: now() });
  };
}

export const teamInvitationRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const params = jsonSchema(teamParamsSchema, { io: 'input' });

    app.get(
      '/teams/:teamId/invitations',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: { params, response: { 200: jsonSchema(teamInvitationsResponseSchema) } },
      },
      (request) => repo.openTeamInvitations(db, (request.params as { readonly teamId: string }).teamId, env.now()),
    );

    app.post(
      '/teams/:teamId/invitations',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: {
          params,
          body: jsonSchema(teamInvitationCreateRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(teamInvitationCreatedSchema) },
        },
      },
      async (request, reply) => {
        const { teamId } = request.params as { readonly teamId: string };
        const body = request.body as TeamInvitationCreateRequest;
        let created: InvitationCreated;
        try {
          // §6: a team invitation can never mint a server admin.
          created = await createInvitation(
            env.invitations,
            { email: body.email, serverAdmin: false, createdBy: request.caller!.id },
            (tx, invitationId) => repo.insertTeamInvitation(tx, { invitationId, teamId, role: body.role }),
          );
        } catch (error) {
          if (error instanceof WirebenchError && error.code === 'identity-user-exists') throw userExistsInvite();
          throw error;
        }
        return reply.code(201).send({
          id: created.id,
          email: created.email,
          role: body.role,
          url: created.url,
          expiresAt: created.expiresAt,
        });
      },
    );

    app.delete(
      '/teams/:teamId/invitations/:id',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: { params: jsonSchema(teamInvitationParamsSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const { teamId, id } = request.params as { readonly teamId: string; readonly id: string };
        if (!(await repo.isTeamInvitation(db, teamId, id))) throw invitationNotFound();
        if (!(await revokeOpenInvitation(env.invitations, id))) throw invitationNotFound();
        return reply.code(204).send();
      },
    );
  };
