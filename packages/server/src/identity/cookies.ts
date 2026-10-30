/**
 * The browser's session cookie (hosted spec §17.2). Its value is a `browser` device token. On an
 * `https:` tenant URL (`tenancy/urls.ts`) it is `__Host-wb_session`, which a browser only keeps when
 * `Secure`, `Path=/` and no `Domain`; on an `http:` one (allowed only with the insecure opt-in) it is
 * `wb_session` without `Secure`, since the browser would drop the `__Host-` one. Parsed and set by hand:
 * one cookie does not justify a plugin.
 */
import type { FastifyReply, FastifyRequest } from 'fastify';

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
 * The flow cookie binds an OIDC or SAML sign-in to the browser that started it: it holds the flow's
 * state, and the callback refuses a state the cookie does not match. Without it, someone could start a
 * flow, stop at the callback URL and hand that URL to another person, who would then be signed in as
 * them (login CSRF). It lives as long as the flow, ten minutes.
 */
export function flowCookieName(url: string): '__Host-wb_flow' | 'wb_flow' {
  return isSecure(url) ? '__Host-wb_flow' : 'wb_flow';
}

const FLOW_COOKIE_SECONDS = 10 * 60;

/**
 * `crossSite` is for SAML, whose IdP posts the response from its own site: a `SameSite=Lax` cookie
 * is not sent on a cross-site POST, so that one is `SameSite=None`, which browsers only keep when
 * `Secure`. OIDC returns by a top-level GET, which `Lax` allows.
 */
export function setFlowCookie(reply: FastifyReply, url: string, state: string, crossSite: boolean): void {
  const secure = isSecure(url);
  const sameSite = crossSite && secure ? 'None' : 'Lax';
  appendSetCookie(
    reply,
    `${flowCookieName(url)}=${state}; Max-Age=${FLOW_COOKIE_SECONDS}; Path=/; HttpOnly${secure ? '; Secure' : ''}; SameSite=${sameSite}`,
  );
}

export function clearFlowCookie(reply: FastifyReply, url: string): void {
  appendSetCookie(reply, `${flowCookieName(url)}=; ${attributes(url, 0)}`);
}

export function flowCookie(request: FastifyRequest, url: string): string | undefined {
  return cookieValue(request, flowCookieName(url));
}
