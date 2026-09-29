/** `ci/whoami` and the CI-token management routes (callback-assertion spec §3). */
import { ciWhoamiResponseSchema } from '@wirebench/engine';
import type { FastifyInstance } from 'fastify';
import type { Querier } from '../context.js';
import { unauthenticated } from '../identity/errors.js';
import { jsonSchema } from '../schema.js';
import * as teamsRepo from '../teams/repo.js';
import { ciTokenRequired } from './errors.js';

export interface CiTokensEnv {
  readonly db: Querier;
  readonly now: () => Date;
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
  };
