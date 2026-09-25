/** `GET /workspaces/:workspaceId/sync/snapshot?at=` (spec §3.2): every file at a commit (default: the head). */
import {
  syncSnapshotQuerySchema,
  syncSnapshotResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncSnapshotResponse,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

type SnapshotQuery = z.infer<typeof syncSnapshotQuerySchema>;

export const snapshotRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/snapshot',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncSnapshotQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncSnapshotResponseSchema) },
        },
      },
      (request): Promise<SyncSnapshotResponse> => {
        const { workspaceId } = request.workspaceAccess!;
        const { at } = request.query as SnapshotQuery;
        return whileRepositoryExists(repos, workspaceId, () => env.store.snapshot(workspaceId, at));
      },
    );
  };
