/**
 * `GET /workspaces/:workspaceId/sync/changes?from=&to=` (spec §3.2): every path that differs, with
 * `null` content for a deletion. An absent `from` is the empty tree (a first pull, or reconnecting, O2).
 */
import {
  syncChangesQuerySchema,
  syncChangesResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncChangesResponse,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

type ChangesQuery = z.infer<typeof syncChangesQuerySchema>;

export const changesRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/changes',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncChangesQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncChangesResponseSchema) },
        },
      },
      (request): Promise<SyncChangesResponse> => {
        const { workspaceId } = request.workspaceAccess!;
        const { from, to } = request.query as ChangesQuery;
        return whileRepositoryExists(repos, workspaceId, () => env.store.changes(workspaceId, from, to));
      },
    );
  };
