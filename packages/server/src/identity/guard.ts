/**
 * The guard other modules use (identity spec §3.2). One `onRequest` hook parses the header when
 * present and leaves `request.caller` undefined when absent; the two `preHandler`s turn absence
 * into `identity-unauthenticated` / `identity-forbidden`. Nothing else in the server reads
 * `Authorization`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import type { IdentityEnv, IdentitySettings } from './env.js';
import { forbidden, unauthenticated, userDisabled } from './errors.js';
import * as repo from './repo.js';
import { bearerToken, hashToken } from './tokens.js';

export interface Caller {
  readonly id: string;
  readonly email: string;
  readonly serverAdmin: boolean;
  readonly tokenId: string;
}

declare module 'fastify' {
  interface FastifyRequest {
    caller?: Caller;
  }
}

/** `last_used_at` is written at most this often per token (§3.1), so a busy client is one update a minute. */
export const TOUCH_EVERY_MS = 60_000;

export function isTokenExpired(
  token: { readonly createdAt: string; readonly lastUsedAt: string },
  now: Date,
  settings: IdentitySettings,
): boolean {
  return (
    now.getTime() - Date.parse(token.lastUsedAt) > settings.tokenIdleMs ||
    now.getTime() - Date.parse(token.createdAt) > settings.tokenMaxMs
  );
}

/** Hex digests of equal length compared in constant time (spec §12), even though the lookup already keyed on the hash. */
function sameHash(a: string, b: string): boolean {
  const left = Buffer.from(a, 'hex');
  const right = Buffer.from(b, 'hex');
  return left.length === right.length && timingSafeEqual(left, right);
}

export function authenticate(env: IdentityEnv): onRequestAsyncHookHandler {
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) return; // no header (or not a device token): the preHandlers decide
    const hash = hashToken(token);
    const found = await repo.tokenByHash(env.ctx.db, hash);
    if (found === undefined || !sameHash(found.token.tokenHash, hash) || found.token.revokedAt !== null)
      throw unauthenticated();
    const now = env.now();
    if (isTokenExpired(found.token, now, env.settings)) {
      await repo.deleteToken(env.ctx.db, found.token.id); // lazy expiry (§3.5); the daily sweep gets the rest
      throw unauthenticated();
    }
    if (found.user.disabledAt !== null) throw userDisabled();
    if (now.getTime() - Date.parse(found.token.lastUsedAt) >= TOUCH_EVERY_MS)
      await repo.touchToken(env.ctx.db, found.token.id, now);
    request.caller = {
      id: found.user.id,
      email: found.user.email,
      serverAdmin: found.user.serverAdmin,
      tokenId: found.token.id,
    };
  };
}

export const requireUser: preHandlerHookHandler = (request, _reply, done) => {
  done(request.caller === undefined ? unauthenticated() : undefined);
};

export const requireServerAdmin: preHandlerHookHandler = (request, _reply, done) => {
  if (request.caller === undefined) done(unauthenticated());
  else done(request.caller.serverAdmin ? undefined : forbidden());
};
