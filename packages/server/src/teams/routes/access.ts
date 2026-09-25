/**
 * `/workspaces/:workspaceId/access` (spec §3.2): the one place a grant is set, and the list that
 * shows every team member's effective role beside its source (§15, role source confusion).
 */
import {
  accessParamsSchema,
  accessResponseSchema,
  setAccessRequestSchema,
  teamWorkspaceParamsSchema,
  type AccessEntry,
  type SetAccessRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { notAMember } from '../errors.js';
import * as repo from '../repo.js';
import { factsOf, requireWorkspaceRole, resolveRole } from '../roles.js';

interface AccessParams {
  readonly workspaceId: string;
  readonly userId: string;
}

export function toAccessEntry(row: repo.AccessRow): AccessEntry {
  const found = resolveRole(factsOf(row));
  return {
    userId: row.userId,
    email: row.email,
    displayName: row.displayName,
    teamRole: row.teamRole,
    disabled: row.disabled,
    effectiveRole: found.role,
    ...(found.role !== 'none' ? { source: found.source } : {}),
    ...(row.grant !== null ? { grant: row.grant } : {}),
  };
}

export const accessRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const db = env.ctx.db;
    const params = jsonSchema(accessParamsSchema, { io: 'input' });

    app.get(
      '/workspaces/:workspaceId/access',
      {
        preHandler: requireWorkspaceRole(db, 'admin'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          response: { 200: jsonSchema(accessResponseSchema) },
        },
      },
      async (request) => (await repo.accessRows(db, request.workspaceAccess!.workspaceId)).map(toAccessEntry),
    );

    app.put(
      '/workspaces/:workspaceId/access/:userId',
      {
        preHandler: requireWorkspaceRole(db, 'admin'),
        schema: { params, body: jsonSchema(setAccessRequestSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const { workspaceId, userId } = request.params as AccessParams;
        const { role } = request.body as SetAccessRequest;
        await db.transaction(async (tx) => {
          if (!(await repo.isTeamMemberOfWorkspace(tx, workspaceId, userId))) throw notAMember();
          await repo.upsertGrant(tx, { workspaceId, userId, role, at: env.now() });
        });
        return reply.code(204).send();
      },
    );

    app.delete(
      '/workspaces/:workspaceId/access/:userId',
      { preHandler: requireWorkspaceRole(db, 'admin'), schema: { params } },
      async (request, reply) => {
        const { workspaceId, userId } = request.params as AccessParams;
        await repo.deleteGrant(db, workspaceId, userId);
        return reply.code(204).send();
      },
    );
  };
