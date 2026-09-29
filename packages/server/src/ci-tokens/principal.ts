/**
 * The CI principal (callback-assertion spec §3). A CI token is a `wbs_` token no device session
 * knows. It reads hooks and captures in its own workspace, plus `ci/whoami`, and nothing else: the
 * allow-list is checked here, in `onRequest`, before any route's own guard runs, so a route added
 * later is refused by default. `request.caller` stays unset, so every `requireUser` route would
 * refuse it anyway.
 */
import type { FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { Querier } from '../context.js';
import { TOUCH_EVERY_MS, type BearerFallback } from '../identity/guard.js';
import { hashToken } from '../identity/tokens.js';
import { ciTokenForbidden } from './errors.js';
import * as repo from './repo.js';

export interface CiCaller {
  readonly tokenId: string;
  readonly tokenName: string;
  readonly workspaceId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    /** Set for a request that carries a live CI token; `caller` is then unset. */
    ciCaller?: CiCaller;
  }
}

/** Every route a CI token may call, as `<method> <route url>` with the `/api/v1` prefix. */
export const CI_ROUTES: ReadonlySet<string> = new Set([
  'GET /api/v1/ci/whoami',
  'GET /api/v1/workspaces/:workspaceId/hooks',
  'GET /api/v1/workspaces/:workspaceId/hooks/:hookId/captures',
  'GET /api/v1/workspaces/:workspaceId/hooks/:hookId/captures/:captureId',
]);

function allowed(request: FastifyRequest, caller: CiCaller): boolean {
  const route = request.routeOptions.url;
  // No such route: let the 404 answer, as it does for anyone.
  if (route === undefined) return true;
  if (!CI_ROUTES.has(`${request.method} ${route}`)) return false;
  const { workspaceId } = request.params as { readonly workspaceId?: string };
  return workspaceId === undefined || workspaceId === caller.workspaceId;
}

export function ciBearer(env: { readonly db: Querier; readonly now: () => Date }): BearerFallback {
  return async (token, request) => {
    if (!DEVICE_TOKEN_PATTERN.test(token)) return false;
    // Looked up by its hash, so the stored value is never compared with the token itself.
    const found = await repo.ciTokenByHash(env.db, hashToken(token));
    if (found === undefined || found.revokedAt !== null) return false;
    const caller: CiCaller = { tokenId: found.id, tokenName: found.name, workspaceId: found.workspaceId };
    if (!allowed(request, caller)) throw ciTokenForbidden();
    const now = env.now();
    if (found.lastUsedAt === null || now.getTime() - Date.parse(found.lastUsedAt) >= TOUCH_EVERY_MS) {
      await repo.touchCiToken(env.db, found.id, now);
    }
    request.ciCaller = caller;
    return true;
  };
}
