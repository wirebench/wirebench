/**
 * The sessions one browser holds (switch accounts spec §5): the active one in the session cookie, the others in the
 * remembered-sessions cookie. Every use of a token from either is checked here first (spec §8): a `browser` token of
 * the request's tenant (the lookup runs in its database, so another tenant's token is simply unknown), not revoked,
 * not past its idle or maximum age, of a user who is not disabled. Nothing here touches `last_used_at`: listing the
 * remembered accounts is not using them.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { announce, recordAudit, type AuditSource, type ServerContext } from '../context.js';
import { tenantUrl } from '../tenancy/urls.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import {
  hasAccountsCookie,
  MAX_REMEMBERED_SESSIONS,
  rememberedTokens,
  sessionToken,
  setAccountsCookie,
} from './cookies.js';
import { identitySettings, type IdentitySettings } from './env.js';
import { isTokenExpired } from './guard.js';
import * as repo from './repo.js';
import { hashToken } from './tokens.js';

export interface SessionEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
}

/** A live browser session the browser presented. `token` stays on the server: it only ever goes back into a cookie. */
export interface BrowserSession {
  readonly token: string;
  readonly tokenId: string;
  readonly createdAt: string;
  readonly user: repo.UserRow;
}

/** The session `token` names, when it is live (see the module comment); `undefined` otherwise. */
export async function liveBrowserSession(
  db: TenantQuerier,
  settings: IdentitySettings,
  now: Date,
  token: string,
): Promise<BrowserSession | undefined> {
  if (!DEVICE_TOKEN_PATTERN.test(token)) return undefined;
  const found = await repo.tokenByHash(db, hashToken(token));
  if (found === undefined || found.token.kind !== 'browser' || found.token.revokedAt !== null) return undefined;
  if (isTokenExpired(found.token, now, settings) || found.user.disabledAt !== null) return undefined;
  return { token, tokenId: found.token.id, createdAt: found.token.createdAt, user: found.user };
}

export interface PresentedSessions {
  /** The session cookie's session, when live. */
  readonly active: BrowserSession | undefined;
  /** The remembered ones that are live, in the cookie's order, one per person and never the active person. */
  readonly remembered: readonly BrowserSession[];
  /** Whether the remembered cookie held anything that is not in `remembered`: a dead token, a repeat, the active person. */
  readonly stale: boolean;
  /** Whether the request carried the remembered cookie at all. */
  readonly presented: boolean;
}

/** Both cookies' sessions, each checked (spec §8). One unit for the lookups. */
export async function presentedSessions(env: SessionEnv, request: FastifyRequest): Promise<PresentedSessions> {
  const url = tenantUrl(env.ctx.config, request);
  const settings = identitySettings(env.ctx.config);
  const activeToken = sessionToken(request, url);
  const tokens = rememberedTokens(request, url);
  const presented = hasAccountsCookie(request, url);
  if (activeToken === undefined && tokens.length === 0)
    return { active: undefined, remembered: [], stale: presented, presented };
  return env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
    const now = env.now();
    const active = activeToken === undefined ? undefined : await liveBrowserSession(tx, settings, now, activeToken);
    const remembered: BrowserSession[] = [];
    for (const token of tokens) {
      if (token === activeToken) continue;
      const session = await liveBrowserSession(tx, settings, now, token);
      if (session === undefined || session.user.id === active?.user.id) continue;
      if (remembered.some((one) => one.user.id === session.user.id)) continue;
      remembered.push(session);
    }
    return { active, remembered, stale: presented && remembered.length !== tokens.length, presented };
  });
}

/** Seconds until `session` reaches its maximum age, at least zero. */
export function remainingSeconds(env: SessionEnv, session: Pick<BrowserSession, 'createdAt'>): number {
  const end = Date.parse(session.createdAt) + identitySettings(env.ctx.config).tokenMaxMs;
  return Math.max(0, Math.floor((end - env.now().getTime()) / 1000));
}

/** Writes the remembered cookie to hold `sessions` (at most four, in order), `Max-Age` the longest remaining life. */
export function writeRemembered(
  env: SessionEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  sessions: readonly BrowserSession[],
): void {
  const kept = sessions.slice(0, MAX_REMEMBERED_SESSIONS);
  const maxAge = kept.reduce((longest, session) => Math.max(longest, remainingSeconds(env, session)), 0);
  setAccountsCookie(
    reply,
    tenantUrl(env.ctx.config, request),
    kept.map((session) => session.token),
    maxAge,
  );
}

/**
 * Revokes `session` as a sign-out of it, with its `auth.signed_out` event and the `sessionEnded` announcement that
 * closes its host sockets with 4401. An anonymous `source` is recorded as the session's own holder.
 */
export async function revokeSession(
  env: SessionEnv,
  request: FastifyRequest,
  session: { readonly tokenId: string; readonly user: repo.UserRow },
  source: AuditSource,
): Promise<void> {
  await env.ctx.tenancy.db(request.tenant).transaction(async (tx) => {
    await repo.revokeToken(tx, session.tokenId, env.now());
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      // The browser presenting the cookie is that session's holder, as the API sign-out's caller is.
      actor:
        source.actor.kind === 'anonymous'
          ? { kind: 'user', userId: session.user.id, email: session.user.email, tokenId: session.tokenId }
          : source.actor,
      action: 'auth.signed_out',
      target: { kind: 'user', id: session.user.id },
      details: { tokenId: session.tokenId },
    });
  });
  announce(env.ctx.hooks.sessionEnded, { tenantId: request.tenant.tenantId, tokenId: session.tokenId }, request.log);
}
