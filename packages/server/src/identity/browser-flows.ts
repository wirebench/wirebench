/**
 * OIDC and SAML sign-ins started from the browser (hosted spec §17.2). The desktop's flows hand a
 * one-time grant to a loopback port; the browser's need none of that: the callback signs the person
 * in, sets the session cookie and redirects. A flow is a `browser_flows` row that keeps only a hash
 * of its state, plus a flow cookie holding the state itself, so the callback can tell that the
 * browser presenting a state is the one that started the flow. Both last ten minutes, like the
 * desktop's flows. Used by identity (OIDC) and sso (SAML). Every flow and token lives in the request's
 * tenant.
 */
import { timingSafeEqual } from 'node:crypto';
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { AuditSource, ServerContext } from '../context.js';
import {
  ADD_ACCOUNT_FLOW_SUFFIX,
  addedToken,
  clearAddedCookie,
  clearFlowCookie,
  flowCookie,
  MAX_REMEMBERED_SESSIONS,
  sessionToken,
  setAddedCookie,
  setFlowCookie,
  setSessionCookie,
} from './cookies.js';
import { identitySettings } from './env.js';
import { emailUnverified, notInvited, userDisabled } from './errors.js';
import * as repo from './repo.js';
import type { UserRow } from './repo.js';
import {
  liveBrowserSession,
  presentedSessions,
  remainingSeconds,
  revokeSession,
  writeRemembered,
  type BrowserSession,
  type PresentedSessions,
} from './remembered.js';
import { signIn } from './sessions.js';
import { sendSignInPage } from './sign-in-page.js';
import { hashSecret, hashToken, mintSecret, newId } from './tokens.js';
import { browserDeviceName } from './device-name.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { primaryUrl, tenantUrl, type UrlConfig } from '../tenancy/urls.js';

/** §2 of the identity spec: a pending flow lives ten minutes. */
export const BROWSER_FLOW_TTL_MS = 10 * 60 * 1000;

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
  /** Started from *Add an account* (switch accounts spec §5.3): finishing it keeps the session the browser holds. */
  readonly addAccount: boolean;
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
export function safeRedirectPath(value: unknown, baseUrl: string): string {
  if (typeof value !== 'string' || value.length > MAX_REDIRECT_LENGTH) return '/';
  if (!value.startsWith('/') || value.startsWith('//') || /[\\\u0000-\u001f\u007f]/.test(value)) return '/';
  let url: URL;
  try {
    url = new URL(value, baseUrl);
  } catch {
    return '/';
  }
  if (url.origin !== new URL(baseUrl).origin) return '/';
  const path = `${url.pathname}${url.search}${url.hash}`;
  // Checked again after parsing: dot-segments can collapse into `//host` (`/..//evil.test` → `//evil.test`),
  // which a browser reads as another origin. One application of this function must be enough.
  if (path.startsWith('//') || path.includes('\\')) return '/';
  return path;
}

/** Stores the flow and sets its cookie; returns the state to send to the IdP. */
export async function startBrowserFlow(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  input: {
    readonly provider: BrowserFlowProvider;
    readonly redirectTo: string;
    readonly nonce?: string;
    readonly codeVerifier?: string;
    readonly addAccount?: boolean;
  },
): Promise<string> {
  const now = env.now();
  const state = mintSecret();
  await env.ctx.tenancy
    .db(request.tenant)
    .query(
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
  setFlowCookie(
    reply,
    tenantUrl(env.ctx.config, request),
    state.secret,
    input.provider === 'saml',
    input.addAccount === true,
  );
  return state.secret;
}

/**
 * A federated sign-in completes on the primary name (hosted spec §23.5): the identity provider knows only the redirect
 * URI or ACS URL on it. So a browser start on the other name answers `302` to the same path and query on the primary,
 * before any flow cookie is set, and the flow cookie and the session land on the name the callback comes back to.
 * Undefined when the request is on the primary already, as every self-hosted request is.
 */
export function onPrimaryHost(
  config: UrlConfig,
  request: FastifyRequest,
  reply: FastifyReply,
): FastifyReply | undefined {
  const primary = primaryUrl(config, request);
  if (tenantUrl(config, request) === primary) return undefined;
  return reply
    .code(302)
    .header('location', new URL(request.url, primary).toString())
    .header('cache-control', 'no-store')
    .send();
}

function sameText(a: string, b: string): boolean {
  const left = Buffer.from(a);
  const right = Buffer.from(b);
  return left.length === right.length && timingSafeEqual(left, right);
}

/** Deletes and returns the flow whose state hashes to `stateHash`: only one caller can ever get it. */
async function claim(
  db: TenantQuerier,
  provider: BrowserFlowProvider,
  stateHash: string,
  addAccount: boolean,
): Promise<BrowserFlow | undefined> {
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
    addAccount,
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
  const url = tenantUrl(env.ctx.config, request);
  const value = flowCookie(request, url);
  const addAccount = value?.endsWith(ADD_ACCOUNT_FLOW_SUFFIX) === true;
  const cookie = addAccount ? value.slice(0, -ADD_ACCOUNT_FLOW_SUFFIX.length) : value;
  // Left alone on a mismatch, so a cross-site request carrying some other state cannot end a flow in progress.
  if (state === '' || cookie === undefined || !sameText(cookie, state)) return undefined;
  clearFlowCookie(reply, url);
  const flow = await claim(env.ctx.tenancy.db(request.tenant), provider, hashSecret(state), addAccount);
  if (flow === undefined || flow.expiresAt.getTime() <= env.now().getTime()) return undefined;
  return flow;
}

/**
 * Revokes the live browser token the request's session cookie holds, if any, as a sign-out of that
 * session. A new sign-in overwrites the cookie, so without this the old token would live on, unseen by
 * the browser, until it expired. Read straight from the cookie: the callbacks do not take a caller from it,
 * and neither does the root `POST /sign-out`, which sits outside the guard.
 */
export async function endPresentedSession(env: FlowEnv, request: FastifyRequest, source: AuditSource): Promise<void> {
  const token = sessionToken(request, tenantUrl(env.ctx.config, request));
  if (token === undefined || !DEVICE_TOKEN_PATTERN.test(token)) return;
  const found = await repo.tokenByHash(env.ctx.tenancy.db(request.tenant), hashToken(token));
  if (found === undefined || found.token.kind !== 'browser' || found.token.revokedAt !== null) return;
  await revokeSession(env, request, { tokenId: found.token.id, user: found.user }, source);
}

/** What *Add an account* says when the browser already holds five (switch accounts spec §5.3). */
export const ACCOUNTS_FULL_MESSAGE = 'This browser already holds five accounts. Sign one out first.';

/**
 * How a browser sign-in treats the sessions the browser already holds (switch accounts spec §5.3). `replace`, every
 * sign-in's mode before accounts could be added, ends the active session; `add` keeps it, remembered in front of the
 * others. In either mode a remembered session of the person signing in is ended and replaced by the new one.
 */
export type BrowserSignInMode = 'replace' | 'add';

/** Which presented sessions a sign-in as `userId` keeps (remembered, in order) and which it ends. */
function arrange(
  presented: PresentedSessions,
  userId: string,
  mode: BrowserSignInMode,
): { readonly keep: readonly BrowserSession[]; readonly end: readonly BrowserSession[]; readonly endActive: boolean } {
  const keep: BrowserSession[] = [];
  const end: BrowserSession[] = [];
  const keepActive = mode === 'add' && presented.active !== undefined && presented.active.user.id !== userId;
  if (keepActive) keep.push(presented.active);
  for (const session of presented.remembered) (session.user.id === userId ? end : keep).push(session);
  return { keep, end, endActive: !keepActive };
}

export const sendAccountsFull = (env: FlowEnv, reply: FastifyReply, redirectTo: string): Promise<FastifyReply> =>
  sendSignInPage(reply, env.ctx, { status: 409, message: ACCOUNTS_FULL_MESSAGE, redirectTo, add: true, full: true });

/**
 * Mints a browser token with its `auth.signed_in` event, sets the session cookie and sends the browser
 * on. In `replace` mode a session the browser already held, for this person or another, is ended first; in `add`
 * mode it moves into the remembered cookie instead, unless it is this person's. An `add` that would leave the
 * browser more than five accounts answers the refusal page and signs no one in.
 */
export async function finishBrowserSignIn(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  method: 'local' | 'oidc' | 'saml',
  source: AuditSource,
  redirectTo: string,
  mode: BrowserSignInMode = 'replace',
): Promise<FastifyReply> {
  const config = env.ctx.config;
  const url = tenantUrl(config, request);
  const presented = await presentedSessions(env, request);
  const { keep, end, endActive } = arrange(presented, user.id, mode);
  if (keep.length > MAX_REMEMBERED_SESSIONS) return sendAccountsFull(env, reply, redirectTo);
  // `replace`, or an `add` by the person already active: the presented session ends, as before accounts.
  if (endActive) await endPresentedSession(env, request, source);
  for (const session of end) await revokeSession(env, request, session, source);
  const deviceName = browserDeviceName(request.headers['user-agent']);
  const { token } = await signIn(env, request.tenant, user, method, deviceName, source, 'browser');
  setSessionCookie(reply, url, token, Math.floor(identitySettings(config).tokenMaxMs / 1000));
  if (presented.presented || keep.length > 0) writeRemembered(env, request, reply, keep);
  return reply
    .code(303)
    .header('location', safeRedirectPath(redirectTo, url))
    .header('cache-control', 'no-store')
    .send();
}

/**
 * Before a browser's second step is verified (two-step sign-in spec §4.1): whether signing in as `userId` in `mode`
 * leaves room, so an *Add an account* past five is refused before a code or passkey is spent.
 */
export async function roomForSignIn(
  env: FlowEnv,
  request: FastifyRequest,
  userId: string,
  mode: BrowserSignInMode,
): Promise<boolean> {
  return arrange(await presentedSessions(env, request), userId, mode).keep.length <= MAX_REMEMBERED_SESSIONS;
}

/**
 * The second step's finish: the session {@link finishBrowserSignIn} would have minted, minted by the second step
 * instead, arranged among the browser's sessions as that does in `mode`. The caller answers the browser.
 */
export async function placeBrowserSession(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  userId: string,
  token: string,
  mode: BrowserSignInMode,
  source: AuditSource,
): Promise<void> {
  const url = tenantUrl(env.ctx.config, request);
  const presented = await presentedSessions(env, request);
  const { keep, end, endActive } = arrange(presented, userId, mode);
  if (endActive) await endPresentedSession(env, request, source);
  for (const session of end) await revokeSession(env, request, session, source);
  setSessionCookie(reply, url, token, Math.floor(identitySettings(env.ctx.config).tokenMaxMs / 1000));
  if (presented.presented || keep.length > 0)
    writeRemembered(env, request, reply, keep.slice(0, MAX_REMEMBERED_SESSIONS));
}

/** Where a SAML *Add an account* lands from its ACS, to see the browser's sessions (see `addedCookieName`). */
export const ADDED_PATH = '/sign-in/added';

/**
 * The SAML ACS's half of *Add an account*: mints the session with its `auth.signed_in` event, hands it over in the
 * added cookie, and redirects to {@link ADDED_PATH}, where {@link adoptAddedSession} arranges it among the others.
 */
export async function handOffAddedSignIn(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  user: UserRow,
  source: AuditSource,
  redirectTo: string,
): Promise<FastifyReply> {
  const url = tenantUrl(env.ctx.config, request);
  const deviceName = browserDeviceName(request.headers['user-agent']);
  const { token } = await signIn(env, request.tenant, user, 'saml', deviceName, source, 'browser');
  setAddedCookie(reply, url, token);
  const onward = safeRedirectPath(redirectTo, url);
  return reply
    .code(303)
    .header('location', onward === '/' ? ADDED_PATH : `${ADDED_PATH}?redirect_to=${encodeURIComponent(onward)}`)
    .header('cache-control', 'no-store')
    .send();
}

/**
 * `GET /sign-in/added`: the handed-over session becomes active and the one the browser held moves into the remembered
 * cookie, as {@link finishBrowserSignIn} does in `add` mode. Without a live handed-over session (none, expired, already
 * used) it answers the sign-in page. Past five accounts the new session is ended again and the refusal answered. A
 * cross-site page can send a browser here, but only a cookie this server set a moment ago makes it do anything.
 */
export async function adoptAddedSession(
  env: FlowEnv,
  request: FastifyRequest,
  reply: FastifyReply,
  source: AuditSource,
  redirectTo: string,
): Promise<FastifyReply> {
  const url = tenantUrl(env.ctx.config, request);
  const token = addedToken(request, url);
  if (token !== undefined) clearAddedCookie(reply, url);
  const added =
    token === undefined
      ? undefined
      : await liveBrowserSession(
          env.ctx.tenancy.db(request.tenant),
          identitySettings(env.ctx.config),
          env.now(),
          token,
        );
  if (added === undefined)
    return sendSignInPage(reply, env.ctx, { status: 400, message: FLOW_EXPIRED_MESSAGE, redirectTo });
  const presented = await presentedSessions(env, request);
  const { keep, end, endActive } = arrange(presented, added.user.id, 'add');
  if (keep.length > MAX_REMEMBERED_SESSIONS) {
    await revokeSession(env, request, added, source);
    return sendAccountsFull(env, reply, redirectTo);
  }
  if (endActive) await endPresentedSession(env, request, source);
  for (const session of end) await revokeSession(env, request, session, source);
  setSessionCookie(reply, url, added.token, remainingSeconds(env, added));
  if (presented.presented || keep.length > 0) writeRemembered(env, request, reply, keep);
  return reply
    .code(303)
    .header('location', safeRedirectPath(redirectTo, url))
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
