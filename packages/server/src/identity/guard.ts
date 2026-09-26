/**
 * The guard other modules use (identity spec §3.2). One `onRequest` hook parses the header when
 * present and leaves `request.caller` undefined when absent; the two `preHandler`s turn absence
 * into `identity-unauthenticated` / `identity-forbidden`. Nothing else in the server reads
 * `Authorization`.
 */
import { timingSafeEqual } from 'node:crypto';
import type { onRequestAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { Querier } from '../context.js';
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

/** A caller as `request.caller` holds it, plus what a live socket needs that a request does not (live-updates §3.3). */
export interface TokenCaller {
  readonly caller: Caller;
  /** `users.display_name`: the name presence shows, never the email (live-updates spec §6). */
  readonly displayName: string;
  /**
   * The token's `created_at`, ISO-8601. A socket outlives any one request, so the hub closes it at
   * this plus `tokenMaxMs` rather than waiting for the next check.
   */
  readonly tokenCreatedAt: string;
}

/**
 * Resolves a device token with every check a request gets (§3.2, §3.5). It throws
 * `identity-unauthenticated` for a malformed, unknown, revoked or expired token (deleting an expired
 * one lazily), and `identity-user-disabled` for a disabled user. It touches `last_used_at` at most
 * once a minute. `authenticate` and the live socket's `auth` message (live-updates spec §3.3, §5.1)
 * both call it, so the two can never disagree about a token.
 */
export async function callerForToken(
  env: { readonly db: Querier; readonly settings: IdentitySettings; readonly now: () => Date },
  token: string,
): Promise<TokenCaller> {
  if (!DEVICE_TOKEN_PATTERN.test(token)) throw unauthenticated(); // no query for something that is not a token
  const hash = hashToken(token);
  const found = await repo.tokenByHash(env.db, hash);
  if (found === undefined || !sameHash(found.token.tokenHash, hash) || found.token.revokedAt !== null)
    throw unauthenticated();
  const now = env.now();
  if (isTokenExpired(found.token, now, env.settings)) {
    await repo.deleteToken(env.db, found.token.id); // lazy expiry (§3.5); the daily sweep gets the rest
    throw unauthenticated();
  }
  if (found.user.disabledAt !== null) throw userDisabled();
  if (now.getTime() - Date.parse(found.token.lastUsedAt) >= TOUCH_EVERY_MS)
    await repo.touchToken(env.db, found.token.id, now);
  return {
    caller: {
      id: found.user.id,
      email: found.user.email,
      serverAdmin: found.user.serverAdmin,
      tokenId: found.token.id,
    },
    displayName: found.user.displayName,
    tokenCreatedAt: found.token.createdAt,
  };
}

export function authenticate(env: IdentityEnv): onRequestAsyncHookHandler {
  const tokens = { db: env.ctx.db, settings: env.settings, now: env.now };
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) return; // no header (or not a device token): the preHandlers decide
    request.caller = (await callerForToken(tokens, token)).caller;
  };
}

export const requireUser: preHandlerHookHandler = (request, _reply, done) => {
  done(request.caller === undefined ? unauthenticated() : undefined);
};

export const requireServerAdmin: preHandlerHookHandler = (request, _reply, done) => {
  if (request.caller === undefined) done(unauthenticated());
  else done(request.caller.serverAdmin ? undefined : forbidden());
};
