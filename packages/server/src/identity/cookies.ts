/**
 * The browser's session cookie (hosted spec §17.2). Its value is a `browser` device token. On an
 * `https:` tenant URL (`tenancy/urls.ts`) it is `__Host-wb_session`, which a browser only keeps when
 * `Secure`, `Path=/` and no `Domain`; on an `http:` one (allowed only with the insecure opt-in) it is
 * `wb_session` without `Secure`, since the browser would drop the `__Host-` one. Parsed and set by hand:
 * one cookie does not justify a plugin.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';

const isSecure = (url: string): boolean => url.startsWith('https:');

export function sessionCookieName(url: string): '__Host-wb_session' | 'wb_session' {
  return isSecure(url) ? '__Host-wb_session' : 'wb_session';
}

function attributes(url: string, maxAgeSeconds: number): string {
  return `Max-Age=${maxAgeSeconds}; Path=/; HttpOnly${isSecure(url) ? '; Secure' : ''}; SameSite=Lax`;
}

/**
 * Adds a `Set-Cookie` line. Fastify's `reply.header` appends for `set-cookie` rather than replacing,
 * so a cookie another part of the server already set survives (the unit test pins this).
 */
function appendSetCookie(reply: FastifyReply, line: string): void {
  reply.header('set-cookie', line);
}

/** `maxAgeSeconds` is the token's maximum age; idle expiry is the server's to enforce, not the browser's. */
export function setSessionCookie(reply: FastifyReply, url: string, token: string, maxAgeSeconds: number): void {
  appendSetCookie(reply, `${sessionCookieName(url)}=${token}; ${attributes(url, maxAgeSeconds)}`);
}

export function clearSessionCookie(reply: FastifyReply, url: string): void {
  appendSetCookie(reply, `${sessionCookieName(url)}=; ${attributes(url, 0)}`);
}

/** The value of the cookie `name` in `Cookie`: the first pair whose name matches exactly, or `undefined`. */
function cookieValue(request: FastifyRequest, name: string): string | undefined {
  const header = request.headers.cookie;
  if (header === undefined) return undefined;
  for (const pair of header.split(';')) {
    const eq = pair.indexOf('=');
    if (eq < 0 || pair.slice(0, eq).trim() !== name) continue;
    const value = pair.slice(eq + 1).trim();
    return value === '' ? undefined : value;
  }
  return undefined;
}

/** The session cookie's value from `Cookie`, or `undefined`. */
export function sessionToken(request: FastifyRequest, url: string): string | undefined {
  return cookieValue(request, sessionCookieName(url));
}

/**
 * The browser's other remembered sessions (switch accounts spec §5.1): the tokens of the accounts it is signed in to
 * besides the active one, space-separated, most recently active first. At most {@link MAX_REMEMBERED_SESSIONS}, so one
 * browser holds five accounts. Same attributes as the session cookie; only the server reads it.
 */
export function accountsCookieName(url: string): '__Host-wb_accounts' | 'wb_accounts' {
  return isSecure(url) ? '__Host-wb_accounts' : 'wb_accounts';
}

/** Ruling 8: four remembered tokens beside the active one. */
export const MAX_REMEMBERED_SESSIONS = 4;

/**
 * The remembered tokens as the browser presented them, in order: anything that is not shaped like a device token is
 * dropped, as is a repeat, and the list stops at {@link MAX_REMEMBERED_SESSIONS}. Whether each is live is the caller's
 * to check, every time (spec §8).
 */
export function rememberedTokens(request: FastifyRequest, url: string): readonly string[] {
  const value = cookieValue(request, accountsCookieName(url));
  if (value === undefined) return [];
  const tokens: string[] = [];
  for (const token of value.split(' ')) {
    if (!DEVICE_TOKEN_PATTERN.test(token) || tokens.includes(token)) continue;
    tokens.push(token);
    if (tokens.length === MAX_REMEMBERED_SESSIONS) break;
  }
  return tokens;
}

/** Whether the request carried the remembered-sessions cookie at all, so a reply only clears one that is there. */
export function hasAccountsCookie(request: FastifyRequest, url: string): boolean {
  return cookieValue(request, accountsCookieName(url)) !== undefined;
}

/** `maxAgeSeconds` is the longest remaining life among `tokens`. An empty list clears the cookie. */
export function setAccountsCookie(
  reply: FastifyReply,
  url: string,
  tokens: readonly string[],
  maxAgeSeconds: number,
): void {
  if (tokens.length === 0) {
    clearAccountsCookie(reply, url);
    return;
  }
  appendSetCookie(reply, `${accountsCookieName(url)}=${tokens.join(' ')}; ${attributes(url, maxAgeSeconds)}`);
}

export function clearAccountsCookie(reply: FastifyReply, url: string): void {
  appendSetCookie(reply, `${accountsCookieName(url)}=; ${attributes(url, 0)}`);
}

/**
 * A session minted by a SAML *Add an account* (switch accounts spec §5.3), on its way to `GET /sign-in/added`. The IdP
 * posts the response cross-site, and under `SameSite=Lax` that post carries neither of the browser's session cookies,
 * so the ACS cannot see which sessions to keep. It hands the new token over in this cookie instead and redirects; the
 * redirect is a top-level GET, which carries them all. It lives five minutes.
 */
export function addedCookieName(url: string): '__Host-wb_added' | 'wb_added' {
  return isSecure(url) ? '__Host-wb_added' : 'wb_added';
}

const ADDED_COOKIE_SECONDS = 5 * 60;

export function setAddedCookie(reply: FastifyReply, url: string, token: string): void {
  appendSetCookie(reply, `${addedCookieName(url)}=${token}; ${attributes(url, ADDED_COOKIE_SECONDS)}`);
}

export function clearAddedCookie(reply: FastifyReply, url: string): void {
  appendSetCookie(reply, `${addedCookieName(url)}=; ${attributes(url, 0)}`);
}

export function addedToken(request: FastifyRequest, url: string): string | undefined {
  return cookieValue(request, addedCookieName(url));
}

/**
 * The flow cookie binds an OIDC or SAML sign-in to the browser that started it: it holds the flow's
 * state, and the callback refuses a state the cookie does not match. Without it, someone could start a
 * flow, stop at the callback URL and hand that URL to another person, who would then be signed in as
 * them (login CSRF). It lives as long as the flow, ten minutes.
 */
export function flowCookieName(url: string): '__Host-wb_flow' | 'wb_flow' {
  return isSecure(url) ? '__Host-wb_flow' : 'wb_flow';
}

const FLOW_COOKIE_SECONDS = 10 * 60;

/** Not in the state's alphabet (base64url), so it can never be part of a state. */
export const ADD_ACCOUNT_FLOW_SUFFIX = '.add';

/**
 * `crossSite` is for SAML, whose IdP posts the response from its own site: a `SameSite=Lax` cookie
 * is not sent on a cross-site POST, so that one is `SameSite=None`, which browsers only keep when
 * `Secure`. OIDC returns by a top-level GET, which `Lax` allows.
 *
 * `addAccount` marks a flow started from *Add an account* (switch accounts spec §5.3): the cookie holds the state
 * followed by {@link ADD_ACCOUNT_FLOW_SUFFIX}, so the callback keeps the session the browser already holds. The mark
 * rides on the cookie, which only this server sets, rather than on the stored flow.
 */
export function setFlowCookie(
  reply: FastifyReply,
  url: string,
  state: string,
  crossSite: boolean,
  addAccount = false,
): void {
  const secure = isSecure(url);
  const sameSite = crossSite && secure ? 'None' : 'Lax';
  appendSetCookie(
    reply,
    `${flowCookieName(url)}=${state}${addAccount ? ADD_ACCOUNT_FLOW_SUFFIX : ''}; Max-Age=${FLOW_COOKIE_SECONDS}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=${sameSite}`,
  );
}

export function clearFlowCookie(reply: FastifyReply, url: string): void {
  appendSetCookie(reply, `${flowCookieName(url)}=; ${attributes(url, 0)}`);
}

export function flowCookie(request: FastifyRequest, url: string): string | undefined {
  return cookieValue(request, flowCookieName(url));
}
