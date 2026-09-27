/**
 * `POST /workspaces/:workspaceId/team-secrets/key-requests` (team-secrets spec §5.1): a member with at least
 * the viewer role adds exactly one file, `team-secrets/keys/<keyId>.yaml`, as a commit authored by the
 * signed-in account. A viewer cannot push, and this is how its machine asks for access. The path comes
 * from the checked `keyId`; the content is never parsed. An existing key file is never overwritten.
 */
import {
  keyRequestPath,
  TEAM_SECRETS_KEY_REQUEST_MAX_BYTES,
  teamSecretsKeyRequestResponseSchema,
  teamSecretsKeyRequestSchema,
  teamWorkspaceParamsSchema,
  type TeamSecretsKeyRequest,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import { announce } from '../../context.js';
import { unauthenticated } from '../../identity/errors.js';
import { findUserById } from '../../identity/repo.js';
import { jsonSchema } from '../../schema.js';
import { workspaceNotFound } from '../../teams/errors.js';
import { requireWorkspaceRole } from '../../teams/roles.js';
import type { SyncEnv } from '../env.js';
import { teamSecretsKeyExists, teamSecretsRequestTooLarge } from '../errors.js';

const CONTROL_CHARACTERS = /[\u0000-\u001f\u007f]/g;

export const keyRequestRoutes =
  (env: SyncEnv) =>
  (app: FastifyInstance): void => {
    const { db, repos, hooks } = env.ctx;
    app.post(
      '/workspaces/:workspaceId/team-secrets/key-requests',
      {
        preHandler: requireWorkspaceRole(db, 'viewer'),
        // A key request is a few hundred bytes; the operator's sync limit is for trees.
        bodyLimit: 16 * 1024,
        schema: {
          params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }),
          body: jsonSchema(teamSecretsKeyRequestSchema, { io: 'input' }),
          response: { 201: jsonSchema(teamSecretsKeyRequestResponseSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const body = request.body as TeamSecretsKeyRequest;
        if (Buffer.byteLength(body.content, 'utf8') > TEAM_SECRETS_KEY_REQUEST_MAX_BYTES) {
          throw teamSecretsRequestTooLarge();
        }
        const user = await findUserById(db, request.caller!.id);
        if (user === undefined) throw unauthenticated();
        const path = keyRequestPath(body.keyId);
        const subject = `Request team secrets access for ${user.displayName.replace(CONTROL_CHARACTERS, ' ')}`;
        const result = await repos.withLock(workspaceId, async () => {
          if (!(await repos.exists(workspaceId))) throw workspaceNotFound();
          const head = await env.store.head(workspaceId);
          if (head !== null && (await env.store.hasFile(workspaceId, head, path))) throw teamSecretsKeyExists();
          return env.store.appendCommits(
            workspaceId,
            head,
            [{ subject, at: new Date().toISOString(), changes: [{ path, encoding: 'utf8', content: body.content }] }],
            { name: user.displayName, email: user.email },
          );
        });
        announce(hooks.headMoved, { workspaceId, head: result.head, tokenId: request.caller!.tokenId }, request.log);
        return reply.code(201).send({ head: result.head });
      },
    );
  };
