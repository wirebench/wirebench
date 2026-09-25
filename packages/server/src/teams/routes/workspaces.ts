/**
 * Workspaces (spec §3.2, §3.7). Creation inserts the row and the creator's grant and builds the
 * bare repository inside one transaction, so a failing build leaves no row; deletion removes the
 * row, then moves the repository away. The row is the source of truth.
 */
import {
  teamParamsSchema,
  teamWorkspaceCreateRequestSchema,
  teamWorkspaceParamsSchema,
  teamWorkspaceSchema,
  teamWorkspacesResponseSchema,
  teamWorkspaceUpdateRequestSchema,
  WirebenchError,
  type RoleSource,
  type TeamWorkspace,
  type TeamWorkspaceCreateRequest,
  type TeamWorkspaceUpdateRequest,
  type WorkspaceRole,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { isForeignKeyViolation, isUniqueViolation } from '../../db/errors.js';
import { requireUser } from '../../identity/guard.js';
import { newId } from '../../identity/tokens.js';
import { jsonSchema } from '../../schema.js';
import type { TeamsEnv } from '../env.js';
import { teamNotFound, workspaceExists, workspaceNameTaken, workspaceNotFound } from '../errors.js';
import { cleanName } from '../names.js';
import * as repo from '../repo.js';
import { effectiveRole, factsOf, requireTeamRole, requireWorkspaceRole, resolveRole } from '../roles.js';

export function toWorkspace(row: repo.WorkspaceRow, myRole: WorkspaceRole, source: RoleSource): TeamWorkspace {
  return {
    id: row.id,
    name: row.name,
    teamId: row.teamId,
    teamName: row.teamName,
    defaultRole: row.defaultRole,
    myRole,
    source,
    createdAt: row.createdAt,
  };
}

/** Racing duplicates answer like the pre-checks would: a taken id, a taken name, an existing repository. */
function conflictOr(error: unknown): never {
  if (isUniqueViolation(error, 'workspaces_pkey')) throw workspaceExists();
  if (isUniqueViolation(error, 'workspaces_team_name_lower')) throw workspaceNameTaken();
  if (error instanceof WirebenchError && error.code === 'server-repo-exists') throw workspaceExists();
  throw error;
}

const isMissing = (error: unknown): boolean => (error as NodeJS.ErrnoException | null)?.code === 'ENOENT';

export const workspaceRoutes =
  (env: TeamsEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos } = env.ctx;
    const params = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });
    const one = jsonSchema(teamWorkspaceSchema);

    app.get(
      '/workspaces',
      { preHandler: requireUser, schema: { response: { 200: jsonSchema(teamWorkspacesResponseSchema) } } },
      async (request) => {
        const caller = request.caller!;
        const rows = await repo.visibleWorkspaces(db, caller.id, caller.serverAdmin);
        return rows.flatMap((row) => {
          const found = resolveRole(factsOf({ ...row, disabled: false, serverAdmin: caller.serverAdmin }));
          return found.role === 'none' ? [] : [toWorkspace(row, found.role, found.source)];
        });
      },
    );

    app.post(
      '/teams/:teamId/workspaces',
      {
        preHandler: requireTeamRole(db, 'member'),
        schema: {
          params: jsonSchema(teamParamsSchema, { io: 'input' }),
          body: jsonSchema(teamWorkspaceCreateRequestSchema, { io: 'input' }),
          response: { 201: one },
        },
      },
      async (request, reply) => {
        const { teamId } = request.params as { readonly teamId: string };
        const body = request.body as TeamWorkspaceCreateRequest;
        const name = cleanName(body.name);
        const id = body.id ?? newId();
        const caller = request.caller!;
        const at = env.now();
        // An object, not a `let`: the flag is set inside the transaction callback.
        const progress = { built: false };
        try {
          await db.transaction(async (tx) => {
            await repo.insertWorkspace(tx, {
              id,
              name,
              teamId,
              defaultRole: body.defaultRole ?? 'viewer',
              createdBy: caller.id,
              at,
            });
            // §3.2: the creator administers what they made. Grants belong to members, so a server
            // admin off the team (admin everywhere anyway) gets none.
            if ((await repo.memberRole(tx, teamId, caller.id)) !== undefined) {
              await repo.upsertGrant(tx, { workspaceId: id, userId: caller.id, role: 'admin', at });
            }
            // §3.7: built before commit, so a failure here rolls the row back.
            await repos.withLock(id, () => repos.create(id));
            progress.built = true;
          });
        } catch (error) {
          if (progress.built) {
            // The commit failed after the repository existed: move it away so the id is usable again.
            await repos
              .withLock(id, () => repos.remove(id))
              .catch((cause: unknown) => {
                request.log.warn(
                  { err: cause, workspaceId: id },
                  'could not move away an uncommitted workspace repository',
                );
              });
          }
          // A racing team delete: the guard passed, but the team was gone by the time this insert
          // ran. Answer like the guard would have (§3.1: not found, never forbidden).
          if (isForeignKeyViolation(error, 'workspaces_team_id_fkey')) throw teamNotFound();
          conflictOr(error);
        }
        const row = (await repo.workspaceById(db, id))!;
        const found = await effectiveRole(db, caller.id, id);
        if (found.role === 'none') throw workspaceNotFound();
        return reply.code(201).send(toWorkspace(row, found.role, found.source));
      },
    );

    app.get(
      '/workspaces/:workspaceId',
      { preHandler: requireWorkspaceRole(db, 'viewer'), schema: { params, response: { 200: one } } },
      async (request) => {
        const access = request.workspaceAccess!;
        return toWorkspace((await repo.workspaceById(db, access.workspaceId))!, access.role, access.source);
      },
    );

    app.patch(
      '/workspaces/:workspaceId',
      {
        preHandler: requireWorkspaceRole(db, 'admin'),
        schema: { params, body: jsonSchema(teamWorkspaceUpdateRequestSchema, { io: 'input' }), response: { 200: one } },
      },
      async (request) => {
        const access = request.workspaceAccess!;
        const body = request.body as TeamWorkspaceUpdateRequest;
        await repo
          .updateWorkspace(db, access.workspaceId, {
            ...(body.name !== undefined ? { name: cleanName(body.name) } : {}),
            ...(body.defaultRole !== undefined ? { defaultRole: body.defaultRole } : {}),
          })
          .catch(conflictOr);
        return toWorkspace((await repo.workspaceById(db, access.workspaceId))!, access.role, access.source);
      },
    );

    app.delete(
      '/workspaces/:workspaceId',
      { preHandler: requireWorkspaceRole(db, 'admin'), schema: { params } },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        // The row delete and the repository move run inside the same per-workspace lock as
        // `create`, so a re-create of this id cannot interleave between them — otherwise it could
        // either see a spurious 409 (the old repository still on disk when it tries to build) or
        // have its brand-new repository moved away by this delete's cleanup.
        await repos.withLock(workspaceId, async () => {
          await repo.deleteWorkspace(db, workspaceId); // grants go by cascade
          // §3.7: the row is the source of truth; the repository moves under tmp/, never deleted.
          await repos.remove(workspaceId).catch((error: unknown) => {
            if (!isMissing(error)) throw error;
            request.log.warn({ workspaceId }, 'deleted a workspace whose repository was already gone');
          });
        });
        return reply.code(204).send();
      },
    );
  };
