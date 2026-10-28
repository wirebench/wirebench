/**
 * OIDC and SAML sign-ins started from the browser (hosted spec §17.2). The desktop's flows hand a
 * one-time grant to a loopback port; the browser's need none of that: the callback signs the person
 * in, sets the session cookie and redirects. A flow is a `browser_flows` row that keeps only a hash
 * of its state, plus a flow cookie holding the state itself, so the callback can tell that the
 * browser presenting a state is the one that started the flow. Both last ten minutes, like the
 * desktop's flows. Used by identity (OIDC) and sso (SAML).
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { announce, recordAudit, type AuditSource, type Querier, type ServerContext } from '../context.js';
import { clearFlowCookie, flowCookie, sessionToken, setFlowCookie, setSessionCookie } from './cookies.js';
import { identitySettings } from './env.js';
import { emailUnverified, notInvited, userDisabled } from './errors.js';
import * as repo from './repo.js';
import type { UserRow } from './repo.js';
import { signIn } from './sessions.js';
import { hashSecret, hashToken, mintSecret, newId } from './tokens.js';

/** §2 of the identity spec: a pending flow lives ten minutes. */
export const BROWSER_FLOW_TTL_MS = 10 * 60 * 1000;

/** What a browser token's row is called on the user's device list. */
const BROWSER_DEVICE_NAME = 'Web browser';

const MAX_REDIRECT_LENGTH = 2048;

export type BrowserFlowProvider = 'oidc' | 'saml';

export interface BrowserFlow {
  readonly id: string;
  readonly provider: BrowserFlowProvider;
  /** OIDC: the ID token's nonce. SAML: the `AuthnRequest` ID the response must answer. */
  readonly nonce: string | null;
  /** OIDC: the PKCE verifier sent with the code. SAML: none. */
  readonly codeVerifier: string | null;
  readonly redirectTo: string;
  readonly expiresAt: Date;
}

interface FlowEnv {
  readonly ctx: ServerContext;
  readonly now: () => Date;
}

/**
 * Where to land after signing in: a path on this server, or `/`. Anything that would leave the
 * origin (an absolute URL, `//host`, a backslash a browser reads as a slash, a scheme) is dropped,
 * so `redirect_to` cannot be used as an open redirect.
 */
export function safeRedirectPath(value: unknown, publicUrl: string): string {
  if (typeof value !== 'string' || value.length > MAX_REDIRECT_LENGTH) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  let url: URL;
  try {
    url = new URL(value, publicUrl);
  } catch {
    return '/';
  }
  if (url.origin !== new URL(publicUrl).origin) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Checked again after parsing: dot-segments can collapse into `//host` (`/..//evil.test` → `//evil.test`),
  // which a browser reads as another origin. One application of this function must be enough.
  if (path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}

/** Stores the flow and sets its cookie; returns the state to send to the IdP. */
export async function startBrowserFlow(
  env: FlowEnv,
  reply: FastifyReply,
  input: {
    readonly provider: BrowserFlowProvider;
    readonly redirectTo: string;
    readonly nonce?: string;
    readonly codeVerifier?: string;
  },
): Promise<string> {
  const now = env.now();
  const state = mintSecret();
  await env.ctx.db.query(
    'insert into browser_flows (id, provider, state_hash, nonce, code_verifier, redirect_to, expires_at, created_at) values ($1, $2, $3, $4, $5, $6, $7, $8)',
    [
      newId(),
      input.provider,
      state.hash,
      input.nonce ?? null,
      input.codeVerifier ?? null,
      input.redirectTo,
      new Date(now.getTime() + BROWSER_FLOW_TTL_MS),
      now,
    ],
  );
  setFlowCookie(reply, env.ctx.config.publicUrl, state.secret, input.provider === 'saml');
  return state.secret;
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Deletes and returns the flow whose state hashes to `stateHash`: only one caller can ever get it. */
async function claim(db: Querier, provider: BrowserFlowProvider, stateHash: string): Promise<BrowserFlow | undefined> {
  const result = await db.query<{
    id: string;
    provider: BrowserFlowProvider;
    nonce: string | null;
    code_verifier: string | null;
    redirect_to: string;
    expires_at: Date | string;
  }>(
    'delete from browser_flows where state_hash = $1 and provider = $2 returning id, provider, nonce, code_verifier, redirect_to, expires_at',
    [stateHash, provider],
  );
  const row = result.rows[0];
  if (row === undefined) return undefined;
  return {
    id: row.id,
    provider: row.provider,
    nonce: row.nonce,
    codeVerifier: row.code_verifier,
    redirectTo: row.redirect_to,
    expiresAt: new Date(row.expires_at),
  };
}

/**
 * The flow a callback's `state` belongs to, used up: `undefined` when the browser's flow cookie does
 * not hold that state (another browser started it), when no such flow is left (replayed), or when it
 * has expired. The flow cookie is cleared once it matched the state, whatever happens to the flow.
 */
export async function takeBrowserFlow(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  provider: BrowserFlowProvider,
  state: string,
): Promise<BrowserFlow | undefined> {
  const publicUrl = env.ctx.config.publicUrl;
  const cookie = flowCookie(request, publicUrl);
  // Left alone on a mismatch, so a cross-site request carrying some other state cannot end a flow in progress.
  if (state === '' || cookie === undefined || !sameText(cookie, state)) return undefined;
  clearFlowCookie(reply, publicUrl);
  const flow = await claim(env.ctx.db, provider, hashSecret(state));
  if (flow === undefined || flow.expiresAt.getTime() <= env.now().getTime()) return undefined;
  return flow;
}

/**
 * Revokes the live browser token the request's session cookie holds, if any, as a sign-out of that
 * session. A new sign-in overwrites the cookie, so without this the old token would live on, unseen by
 * the browser, until it expired. Read straight from the cookie: the callbacks do not take a caller from it.
 */
async function endPresentedSession(env: FlowEnv, request: FastifyRequest, source: AuditSource): Promise<void> {
  const token = sessionToken(request, env.ctx.config.publicUrl);
  if (token === undefined || !DEVICE_TOKEN_PATTERN.test(token)) return;
  const found = await repo.tokenByHash(env.ctx.db, hashToken(token));
  if (found === undefined || found.token.kind !== 'browser' || found.token.revokedAt !== null) return;
  const tokenId = found.token.id;
  await env.ctx.db.transaction(async (tx) => {
    await repo.revokeToken(tx, tokenId, env.now());
    await recordAudit(env.ctx.hooks, tx, {
      ...source,
      action: 'auth.signed_out',
      target: { kind: 'user', id: found.user.id },
      details: { tokenId },
    });
  });
  announce(env.ctx.hooks.sessionEnded, { tokenId }, request.log);
}

/**
 * Mints a browser token with its `auth.signed_in` event, sets the session cookie and sends the browser
 * on. A session the browser already held, for this person or another, is ended first.
 */
export async function finishBrowserSignIn(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  method: 'local' | 'oidc' | 'saml',
  source: AuditSource,
  redirectTo: string,
): Promise<FastifyReply> {
  const config = env.ctx.config;
  await endPresentedSession(env, request, source);
  const { token } = await signIn(env, user, method, BROWSER_DEVICE_NAME, source, 'browser');
  setSessionCookie(reply, config.publicUrl, token, Math.floor(identitySettings(config).tokenMaxMs / 1000));
  return reply
    .code(303)
    .header('location', safeRedirectPath(redirectTo, config.publicUrl))
    .header('cache-control', 'no-store')
    .send();
}

/** What the page says when a flow could not be used: unknown, replayed, expired or another browser's. */
export const FLOW_EXPIRED_MESSAGE = 'This sign-in has expired or was already completed. Start again.';

/** What the page says for a refusal code the IdP's answer led to. Neutral for anything unexpected. */
export function refusalMessage(code: string): string {
  switch (code) {
    case 'identity-user-disabled':
      return userDisabled().message;
    case 'identity-email-unverified':
      return emailUnverified().message;
    case 'identity-not-invited':
      return notInvited().message;
    case 'licensing-seat-limit':
      return 'This server has no free seat for a new account. Ask a server admin.';
    case 'licensing-feature-required':
      return 'This server’s license does not include single sign-on.';
    case 'identity-saml-no-email':
      return 'The identity provider did not send an email address for this account.';
    case 'identity-oidc-refused':
    case 'identity-oidc-failed':
      return 'The identity provider did not complete the sign-in.';
    default:
      return 'The identity provider’s answer could not be accepted. Start again or ask a server admin.';
  }
}
