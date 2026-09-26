/**
 * `/teams/:teamId/members` (spec §3.2). Every change that could drop the last admin locks the team
 * row first and counts inside the lock (R4), so concurrent demotions cannot both pass.
 */
import {
  memberAddRequestSchema,
  memberParamsSchema,
  memberRoleRequestSchema,
  teamMemberSchema,
  teamMembersResponseSchema,
  teamParamsSchema,
  type MemberAddRequest,
  type MemberRoleRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { isForeignKeyViolation } from '../../db/errors.js';
import { findUserByEmail } from '../../identity/repo.js';
import { emailLower } from '../../identity/sessions.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { alreadyMember, forbidden, lastAdmin, memberNotFound, teamNotFound, userUnknown } from '../errors.js';
import * as repo from '../repo.js';
import { requireTeamRole } from '../roles.js';

interface MemberParams {
  readonly teamId: string;
  readonly userId: string;
}

export const memberRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const teamParams = jsonSchema(teamParamsSchema, { io: 'input' });
    const params = jsonSchema(memberParamsSchema, { io: 'input' });

    app.get(
      '/teams/:teamId/members',
      {
        preHandler: requireTeamRole(db, 'member'),
        schema: { params: teamParams, response: { 200: jsonSchema(teamMembersResponseSchema) } },
      },
      (request) => repo.listMembers(db, (request.params as { readonly teamId: string }).teamId),
    );

    app.post(
      '/teams/:teamId/members',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: {
          params: teamParams,
          body: jsonSchema(memberAddRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(teamMemberSchema) },
        },
      },
      async (request, reply) => {
        const { teamId } = request.params as { readonly teamId: string };
        const body = request.body as MemberAddRequest;
        const user = await findUserByEmail(db, emailLower(body.email));
        if (user === undefined) throw userUnknown();
        try {
          if (!(await repo.insertMember(db, { teamId, userId: user.id, role: body.role, at: env.now() }))) {
            throw alreadyMember();
          }
        } catch (error) {
          // A racing team delete: the guard passed, but the team was gone by the time this insert
          // ran. Answer like the guard would have (§3.1: not found, never forbidden).
          if (isForeignKeyViolation(error, 'team_members_team_id_fkey')) throw teamNotFound();
          throw error;
        }
        // The team's default roles now reach them on every team workspace (§3.2).
        announce(env.ctx.hooks.accessChanged, { teamId, userId: user.id }, request.log);
        return reply.code(201).send(await repo.memberOf(db, teamId, user.id));
      },
    );

    app.patch(
      '/teams/:teamId/members/:userId',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: {
          params,
          body: jsonSchema(memberRoleRequestSchema, { io: 'input' }),
          response: { 200: jsonSchema(teamMemberSchema) },
        },
      },
      async (request) => {
        const { teamId, userId } = request.params as MemberParams;
        const { role } = request.body as MemberRoleRequest;
        await db.transaction(async (tx) => {
          await repo.lockTeam(tx, teamId);
          const current = await repo.memberRole(tx, teamId, userId);
          if (current === undefined) throw memberNotFound();
          if (current === 'admin' && role !== 'admin' && (await repo.countAdmins(tx, teamId)) <= 1) throw lastAdmin();
          await repo.setMemberRole(tx, teamId, userId, role);
        });
        // Committed: a refused last-admin demotion threw inside the transaction and never gets here.
        announce(env.ctx.hooks.accessChanged, { teamId, userId }, request.log);
        return (await repo.memberOf(db, teamId, userId))!;
      },
    );

    app.delete(
      '/teams/:teamId/members/:userId',
      { preHandler: requireTeamRole(db, 'member'), schema: { params } },
      async (request, reply) => {
        const { teamId, userId } = request.params as MemberParams;
        // §16 question 2: a member may leave; removing anyone else takes a team admin.
        if (request.teamAccess!.role !== 'admin' && userId !== request.caller!.id) throw forbidden();
        await db.transaction(async (tx) => {
          await repo.lockTeam(tx, teamId);
          const current = await repo.memberRole(tx, teamId, userId);
          if (current === undefined) throw memberNotFound();
          if (current === 'admin' && (await repo.countAdmins(tx, teamId)) <= 1) throw lastAdmin();
          // §6: their access to every team workspace ends with the membership, in one transaction.
          await repo.deleteGrantsInTeam(tx, teamId, userId);
          await repo.deleteMember(tx, teamId, userId);
        });
        announce(env.ctx.hooks.accessChanged, { teamId, userId }, request.log);
        return reply.code(204).send();
      },
    );
  };
