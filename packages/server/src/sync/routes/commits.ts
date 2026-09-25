/**
 * `POST /workspaces/:workspaceId/sync/commits` (spec §3.2): an editor's pending commits become git
 * commits on main, authored by the signed-in account (§6). Inside the workspace lock, the repository
 * is checked again first (R11: a delete may have won the race for the lock). The commit store then
 * refuses a stale parent with 409 (R3) or appends every commit in order.
 */
import {
  syncPushRequestSchema,
  syncPushResponseSchema,
  teamWorkspaceParamsSchema,
  type SyncPushRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { unauthenticated } from '../../identity/errors.js';
import { findUserById } from '../../identity/repo.js';
import { jsonSchema } from '../../schema.js';
import { workspaceNotFound } from '../../teams/errors.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import type { SyncEnv } from '../env.js';
import { syncSubjectInvalid } from '../errors.js';

/** C0 controls and DEL: NUL cannot be a git argument, and a line break would start a message body. */
const CONTROL_CHARACTER = /[\u0000-\u001f\u007f]/;

export const commitRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    app.post(
      '/workspaces/:workspaceId/sync/commits',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          body: jsonSchema(syncPushRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(syncPushResponseSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as SyncPushRequest;
        // The commit store takes the subject as is; JSON Schema cannot say "no control characters".
        if (body.commits.some((c) => CONTROL_CHARACTER.test(c.subject))) throw syncSubjectInvalid();
        // R2, §6: the author is the account, never anything in the body; request.caller has no name.
        const user = await findUserById(db, request.caller!.id);
        if (user === undefined) throw unauthenticated();
        const author = { name: user.displayName, email: user.email };
        const result = await repos.withLock(workspaceId, async () => {
          if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
          return env.store.appendCommits(workspaceId, body.parent, body.commits, author);
        });
        return reply.code(201).send(result);
      },
    );
  };
