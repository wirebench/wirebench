/** `ci/whoami` and the CI-token management routes (callback-assertion spec §3). */
import { z } from 'zod';
import {
  CI_TOKEN_NAME_MAX_LENGTH,
  ciTokenCreatedSchema,
  ciTokenParamsSchema,
  ciTokensResponseSchema,
  ciWhoamiResponseSchema,
  teamWorkspaceParamsSchema,
  type CiTokenSummary,
} from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { Querier } from '../context.js';
import { isUniqueViolation } from '../db/errors.js';
import { unauthenticated } from '../identity/errors.js';
import { mintToken, newId } from '../identity/tokens.js';
import { jsonSchema } from '../schema.js';
import { requireWorkspaceRole } from '../teams/roles.js';
import * as teamsRepo from '../teams/repo.js';
import { ciTokenNameBlank, ciTokenNameTaken, ciTokenNotFound, ciTokenRequired } from './errors.js';
import * as repo from './repo.js';

export interface CiTokensEnv {
  readonly db: Querier;
  readonly now: () => Date;
}

/**
 * The wire schema bounds the name before it is trimmed, which would refuse a 64-character name with
 * padding; the body is checked here loosely and the handler enforces 1–64 on the trimmed name.
 */
const createBodySchema = z.object({ name: z.string().max(1024) });

const NAME_INDEX = 'ci_tokens_workspace_name_lower';

function summaryOf(row: repo.CiTokenRow): CiTokenSummary {
  return {
    id: row.id,
    name: row.name,
    createdBy: row.createdByName,
    createdAt: row.createdAt,
    lastUsedAt: row.lastUsedAt,
  };
}

export const ciRoutes =
  (env: CiTokensEnv) =>
  (app: FastifyInstance): void => {
    app.get('/ci/whoami', { schema: { response: { 200: jsonSchema(ciWhoamiResponseSchema) } } }, async (request) => {
      const ci = request.ciCaller;
      if (ci === undefined) throw request.caller === undefined ? unauthenticated() : ciTokenRequired();
      const workspace = await teamsRepo.workspaceById(env.db, ci.workspaceId);
      // The token goes with its workspace (cascade), so this is a race with a delete at most.
      if (workspace === undefined) throw unauthenticated();
      return { workspaceId: ci.workspaceId, workspaceName: workspace.name, tokenName: ci.tokenName };
    });
    const { db } = env;
    const workspaceParams = jsonSchema(teamWorkspaceParamsSchema, { io: 'input' });

    app.post(
      '/workspaces/:workspaceId/ci-tokens',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: {
          params: workspaceParams,
          body: jsonSchema(createBodySchema, { io: 'input' }),
          response: { 201: jsonSchema(ciTokenCreatedSchema) },
        },
      },
      async (request, reply) => {
        const { workspaceId } = request.workspaceAccess!;
        const name = (request.body as z.infer<typeof createBodySchema>).name.trim();
        if (name.length === 0 || name.length > CI_TOKEN_NAME_MAX_LENGTH) throw ciTokenNameBlank();
        const minted = mintToken();
        const id = newId();
        try {
          await repo.insertCiToken(db, {
            id,
            workspaceId,
            name,
            tokenHash: minted.hash,
            createdBy: request.caller!.id,
            at: env.now(),
          });
        } catch (error) {
          if (isUniqueViolation(error, NAME_INDEX)) throw ciTokenNameTaken(name);
          throw error;
        }
        // The only time the token leaves the server; only its hash was stored.
        return reply.code(201).send({ id, name, token: minted.token });
      },
    );

    app.get(
      '/workspaces/:workspaceId/ci-tokens',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: { params: workspaceParams, response: { 200: jsonSchema(ciTokensResponseSchema) } },
      },
      async (request): Promise<CiTokenSummary[]> =>
        (await repo.ciTokensOfWorkspace(db, request.workspaceAccess!.workspaceId)).map(summaryOf),
    );

    app.delete(
      '/workspaces/:workspaceId/ci-tokens/:tokenId',
      {
        preHandler: requireWorkspaceRole(db, 'editor'),
        schema: { params: jsonSchema(ciTokenParamsSchema, { io: 'input' }) },
      },
      async (request, reply) => {
        const { tokenId } = request.params as { readonly tokenId: string };
        const revoked = await repo.revokeCiToken(db, request.workspaceAccess!.workspaceId, tokenId, env.now());
        if (!revoked) throw ciTokenNotFound();
        return reply.code(204).send();
      },
    );
  };
