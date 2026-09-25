/** `/teams` (spec §3.2): list, create, rename, delete. */
import {
  teamNameRequestSchema,
  teamParamsSchema,
  teamSchema,
  teamsResponseSchema,
  type Team,
  type TeamNameRequest,
  type TeamRole,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import { requireServerAdmin, requireUser } from '../../identity/guard.js';
import { newId } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { nameTaken, notEmpty, teamNotFound } from '../errors.js';
import { cleanName } from '../names.js';
import * as repo from '../repo.js';
import { requireTeamRole } from '../roles.js';

const toTeam = (row: repo.TeamRow, myRole: TeamRole): Team => ({
  id: row.id,
  name: row.name,
  myRole,
  createdAt: row.createdAt,
});

/** A racing duplicate name answers like the pre-check would. */
function nameTakenOr(error: unknown): never {
  if (isUniqueViolation(error, 'teams_name_lower')) throw nameTaken();
  throw error;
}

export const teamRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const params = jsonSchema(teamParamsSchema, { io: 'input' });
    const nameBody = jsonSchema(teamNameRequestSchema, { io: 'input' });

    app.get(
      '/teams',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(teamsResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        if (caller.serverAdmin) return (await repo.allTeams(db)).map((row) => toTeam(row, 'admin'));
        return (await repo.teamsOfUser(db, caller.id)).map((row) => toTeam(row, row.role));
      },
    );

    app.post(
      '/teams',
      { preHandler: requireServerAdmin, schema: { body: nameBody, response: { 201: jsonSchema(teamSchema) } } },
      async (request, reply) => {
        const name = cleanName((request.body as TeamNameRequest).name);
        const caller = request.caller!;
        const at = env.now();
        const team = await db
          .transaction(async (tx) => {
            const row = await repo.insertTeam(tx, { id: newId(), name, at });
            // §3.2: the creator is the first admin, so a team never exists without one.
            await repo.insertMember(tx, { teamId: row.id, userId: caller.id, role: 'admin', at });
            return row;
          })
          .catch(nameTakenOr);
        return reply.code(201).send(toTeam(team, 'admin'));
      },
    );

    app.patch(
      '/teams/:teamId',
      {
        preHandler: requireTeamRole(db, 'admin'),
        schema: { params, body: nameBody, response: { 200: jsonSchema(teamSchema) } },
      },
      async (request) => {
        const { teamId } = request.params as { readonly teamId: string };
        const name = cleanName((request.body as TeamNameRequest).name);
        const row = await repo.renameTeam(db, teamId, name).catch(nameTakenOr);
        return toTeam(row, request.teamAccess!.role);
      },
    );

    app.delete('/teams/:teamId', { preHandler: requireServerAdmin, schema: { params } }, async (request, reply) => {
      const { teamId } = request.params as { readonly teamId: string };
      await db
        .transaction(async (tx) => {
          if (!(await repo.lockTeam(tx, teamId))) throw teamNotFound();
          if (await repo.teamHasWorkspaces(tx, teamId)) throw notEmpty();
          await repo.deleteTeam(tx, teamId);
        })
        .catch((error: unknown) => {
          // A workspace created between the check and the delete: the foreign key refuses it.
          if (isForeignKeyViolation(error)) throw notEmpty();
          throw error;
        });
      return reply.code(204).send();
    });
  };
