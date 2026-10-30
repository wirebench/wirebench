/**
 * The guard other modules use (identity spec §3.2). One `onRequest` hook parses the header when
 * present and leaves `request.caller` undefined when absent; the two `preHandler`s turn absence
 * into `identity-unauthenticated` / `identity-forbidden`. Nothing else in the server reads
 * `Authorization`. With the browser client on, the same hook also reads the session cookie
 * (hosted spec §17.2).
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyRequest, onRequestAsyncHookHandler, preHandlerHookHandler } from 'fastify';
import { DEVICE_TOKEN_PATTERN, isWirebenchError } from '@wirebench/engine';
import type { IdentityEnv, IdentitySettings } from './env.js';
import { sessionToken } from './cookies.js';
import { forbidden, originRefused, unauthenticated, userDisabled } from './errors.js';
import * as repo from './repo.js';
import { bearerToken, hashToken } from './tokens.js';
import type { TenantDb } from '../tenancy/tenant-db.js';
import { tenantUrl } from '../tenancy/urls.js';

export interface Caller {
  readonly id: string;
  readonly email: string;
  readonly serverAdmin: boolean;
  readonly tokenId: string;
  /** How the token arrived: an `Authorization` header, or the browser's session cookie (hosted spec §17.2). */
  readonly via: 'bearer' | 'cookie';
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
 * both call it, so the two can never disagree about a token. From the cookie (`via: 'cookie'`) only a
 * `browser` token counts, so a desktop's token cannot be replayed as a browser session. `db` is the
 * request's tenant: a token is found by its hash within that tenant only.
 */
export async function callerForToken(
  env: { readonly db: TenantDb; readonly settings: IdentitySettings; readonly now: () => Date },
  token: string,
  via: Caller['via'] = 'bearer',
): Promise<TokenCaller> {
  if (!DEVICE_TOKEN_PATTERN.test(token)) throw unauthenticated(); // no query for something that is not a token
  const hash = hashToken(token);
  // One unit for the lookup, the lazy delete and the touch (Task 8 review M3): every authenticated request
  // pays for it. A refusal is answered after the unit, so the lazy delete commits rather than rolling back.
  const outcome = await env.db.transaction(async (tx) => {
    const found = await repo.tokenByHash(tx, hash);
    if (found === undefined || !sameHash(found.token.tokenHash, hash) || found.token.revokedAt !== null)
      return 'unauthenticated';
    if (via === 'cookie' && found.token.kind !== 'browser') return 'unauthenticated';
    // Read after the lookup, as the clock stands when the token is judged.
    const now = env.now();
    if (isTokenExpired(found.token, now, env.settings)) {
      await repo.deleteToken(tx, found.token.id); // lazy expiry (§3.5); the daily sweep gets the rest
      return 'unauthenticated';
    }
    if (found.user.disabledAt !== null) return 'disabled';
    if (now.getTime() - Date.parse(found.token.lastUsedAt) >= TOUCH_EVERY_MS)
      await repo.touchToken(tx, found.token.id, now);
    return found;
  });
  if (outcome === 'unauthenticated') throw unauthenticated();
  if (outcome === 'disabled') throw userDisabled();
  const found = outcome;
  return {
    caller: {
      id: found.user.id,
      email: found.user.email,
      serverAdmin: found.user.serverAdmin,
      tokenId: found.token.id,
      via,
    },
    displayName: found.user.displayName,
    tokenCreatedAt: found.token.createdAt,
  };
}

/**
 * Another module's bearer credential, tried when no device token matches (callback-assertion §3):
 * `true` when it recognised the token and set up the request, `false` to let the next one try. It
 * may throw a problem of its own. Nothing but a fallback ever reads a token a device session refused.
 */
export type BearerFallback = (token: string, request: FastifyRequest) => Promise<boolean>;

declare module 'fastify' {
  interface FastifyInstance {
    /** Filled by modules registered after identity; read by `authenticate` at request time. */
    bearerFallbacks: BearerFallback[];
  }
  interface FastifyContextConfig {
    /**
     * `false` on a route that takes no caller and is posted to by another site: an IdP's SAML ACS or
     * an OIDC callback. The guard then ignores the session cookie entirely, so a browser that already
     * holds a session is neither signed in by it nor refused for the IdP's `Origin`.
     */
    cookieAuth?: boolean;
  }
}

/** Methods a cross-site page may trigger with the cookie under `SameSite=Lax`; every other one needs our `Origin`. */
const SAFE_METHODS = new Set(['GET', 'HEAD']);

/**
 * The session cookie, tried only when no `Authorization` header named a token. A cookie the guard
 * refuses as unknown, revoked or expired leaves the caller undefined, as if absent: a stale cookie must
 * not break the routes that need no caller, and `requireUser` still answers `401`. A write
 * authenticated this way must carry `Origin` equal to the tenant's URL (CSRF; hosted spec §17.2).
 */
async function cookieCaller(env: IdentityEnv, tokens: TokenEnv, request: FastifyRequest): Promise<void> {
  const url = tenantUrl(env.ctx.config, request);
  const token = sessionToken(request, url);
  if (token === undefined) return;
  let caller: Caller;
  try {
    caller = (await callerForToken(tokens, token, 'cookie')).caller;
  } catch (error) {
    if (isWirebenchError(error) && error.code === 'identity-unauthenticated') return;
    throw error;
  }
  if (!SAFE_METHODS.has(request.method) && request.headers.origin !== url) throw originRefused();
  request.caller = caller;
}

type TokenEnv = Parameters<typeof callerForToken>[0];

export function authenticate(env: IdentityEnv, fallbacks: readonly BearerFallback[] = []): onRequestAsyncHookHandler {
  // Read only when a credential arrived, so a request without one needs no tenant database.
  const tokensOf = (request: FastifyRequest): TokenEnv => ({
    db: env.ctx.tenancy.db(request.tenant),
    settings: env.settings,
    now: env.now,
  });
  return async (request) => {
    const token = bearerToken(request.headers.authorization);
    if (token === undefined) {
      // No header (or not a device token): the cookie when the browser client is on, else the preHandlers decide.
      if (env.ctx.config.browserClient && request.routeOptions.config.cookieAuth !== false)
        await cookieCaller(env, tokensOf(request), request);
      return;
    }
    try {
      request.caller = (await callerForToken(tokensOf(request), token)).caller;
    } catch (error) {
      if (!isWirebenchError(error) || error.code !== 'identity-unauthenticated') throw error;
      for (const fallback of fallbacks) {
        if (await fallback(token, request)) return;
      }
      throw error;
    }
  };
}

export const requireUser: preHandlerHookHandler = (request, _reply, done) => {
  done(request.caller === undefined ? unauthenticated() : undefined);
};

export const requireServerAdmin: preHandlerHookHandler = (request, _reply, done) => {
  if (request.caller === undefined) done(unauthenticated());
  else done(request.caller.serverAdmin ? undefined : forbidden());
};
