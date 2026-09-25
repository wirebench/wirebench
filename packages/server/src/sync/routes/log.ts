/** `GET /workspaces/:workspaceId/sync/log?limit=` (spec §3.2): newest first, 1 to 200 entries. */
import {
  syncLogQuerySchema,
  syncLogResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncLogEntry,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { z } from 'zod';
import { jsonSchema } from '../../schema.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import { whileRepositoryExists, type SyncEnv } from '../env.js';

type LogQuery = z.infer<typeof syncLogQuerySchema>;

/** The popover's page when a client names no limit; the app always does. */
const DEFAULT_LOG_LIMIT = 50;

export const logRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.get(
      '/workspaces/:workspaceId/sync/log',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          querystring: jsonSchema(syncLogQuerySchema, { io: 'input' }),
          response: { 200: jsonSchema(syncLogResponseSchema) },
        },
      },
      (request): Promise<SyncLogEntry[]> => {
        const { workspaceId } = request.workspaceAccess!;
        const { limit } = request.query as LogQuery;
        return whileRepositoryExists(repos, workspaceId, () => env.store.log(workspaceId, limit ?? DEFAULT_LOG_LIMIT));
      },
    );
  };
