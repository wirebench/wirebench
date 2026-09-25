/**
 * `GET /workspaces/:workspaceId/sync/head` (spec §3.2): the head, the commit counts and the caller's
 * role, which the app refreshes on every fetch (the viewer badge, R2).
 */
import {
  syncHeadQuerySchema,
  syncHeadResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncHeadQuery,
  type SyncHeadResponse,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

export const headRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/head',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncHeadQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncHeadResponseSchema) },
        },
      },
      (request): Promise<SyncHeadResponse> => {
        const { workspaceId, role } = request.workspaceAccess!;
        const { from } = request.query as SyncHeadQuery;
        return whileRepositoryExists(repos, workspaceId, async () => {
          const head = await env.store.head(workspaceId);
          const { commits, behind } = await env.store.counts(workspaceId, from, head);
          return { head, commits, ...(behind !== undefined ? { behind } : {}), role };
        });
      },
    );
  };
