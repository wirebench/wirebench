/**
 * The CI principal (callback-assertion spec §3). A CI token is a `wbs_` token no device session
 * knows. It reads hooks and captures in its own workspace, plus `ci/whoami`, and nothing else: the
 * allow-list is checked here, in `onRequest`, before any route's own guard runs, so a route added
 * later is refused by default. `request.caller` stays unset, so every `requireUser` route would
 * refuse it anyway.
 */
import type { FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { TOUCH_EVERY_MS, type BearerFallback } from '../identity/guard.js';
import { hashToken } from '../identity/tokens.js';
import { ciTokenForbidden } from './errors.js';
import * as repo from './repo.js';
import type { Tenancy } from '../tenancy/tenancy.js';

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

/**
 * Looks the token up in the request's tenant (hosted edition spec §19.8 guard 2), and touches it there in the
 * same unit: every request a CI job makes pays for one unit, not two. A refusal is answered after the unit.
 */
export function ciBearer(env: { readonly tenancy: Pick<Tenancy, 'db'>; readonly now: () => Date }): BearerFallback {
  return async (token, request) => {
    if (!DEVICE_TOKEN_PATTERN.test(token)) return false;
    const outcome = await env.tenancy.db(request.tenant).transaction(async (tx) => {
      // Looked up by its hash, so the stored value is never compared with the token itself.
      const found = await repo.ciTokenByHash(tx, hashToken(token));
      if (found === undefined || found.revokedAt !== null) return 'unknown';
      const caller: CiCaller = { tokenId: found.id, tokenName: found.name, workspaceId: found.workspaceId };
      if (!allowed(request, caller)) return 'forbidden';
      const now = env.now();
      if (found.lastUsedAt === null || now.getTime() - Date.parse(found.lastUsedAt) >= TOUCH_EVERY_MS) {
        await repo.touchCiToken(tx, found.id, now);
      }
      return caller;
    });
    if (outcome === 'unknown') return false;
    if (outcome === 'forbidden') throw ciTokenForbidden();
    request.ciCaller = outcome;
    return true;
  };
}
