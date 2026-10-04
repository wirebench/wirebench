/**
 * RFC 6265 matching for the cookie jar (`rest/cookie-jar.ts`): domain-match and path-match (§5.1.3,
 * §5.1.4), expiry (§5.3), and the `Cookie` header (§5.4).
 *
 * Every REST send stores what its responses set in a jar: the open workspace's in the app, the run's
 * on the command line. A request sends the jar's matching cookies only when its *Send cookies*
 * setting is on, which is off by default, so a saved request stays reproducible unless it opts in.
 * The app saves only cookies with an expiry, encrypted; session cookies never reach disk.
 */

import type { Cookie } from './response.js';

/** True when `host` is `domain` or a subdomain of it (RFC 6265 §5.1.3). */
export function domainMatches(host: string, domain: string): boolean {
  const lowerHost = host.toLowerCase();
  const lowerDomain = domain.replace(/^\./, '').toLowerCase();
  if (lowerHost === lowerDomain) {
    return true;
  }
  return lowerHost.endsWith(`.${lowerDomain}`) && !/^\d+(?:\.\d+){3}$/.test(lowerHost);
}

/** The default path of a cookie set by `pathname`: everything up to its last `/` (§5.1.4). */
export function defaultPath(pathname: string): string {
  if (!pathname.startsWith('/')) {
    return '/';
  }
  const lastSlash = pathname.lastIndexOf('/');
  return lastSlash === 0 ? '/' : pathname.slice(0, lastSlash);
}

/** True when a cookie scoped to `cookiePath` applies to `requestPath` (§5.1.4). */
export function pathMatches(requestPath: string, cookiePath: string): boolean {
  const path = requestPath === '' ? '/' : requestPath;
  if (path === cookiePath) {
    return true;
  }
  if (!path.startsWith(cookiePath)) {
    return false;
  }
  return cookiePath.endsWith('/') || path[cookiePath.length] === '/';
}

/** Whether a cookie has expired at `now`, by `Max-Age` first and then `Expires` (§5.3). */
export function isExpired(cookie: Cookie, now: Date, setAt?: Date): boolean {
  if (cookie.maxAge !== undefined) {
    if (cookie.maxAge <= 0) {
      return true;
    }
    const from = setAt ?? now;
    return now.getTime() > from.getTime() + cookie.maxAge * 1000;
  }
  if (cookie.expires === undefined) {
    return false;
  }
  const expires = new Date(cookie.expires);
  return !Number.isNaN(expires.getTime()) && expires.getTime() <= now.getTime();
}

/**
 * The `Cookie` header value for `cookies`, or `undefined` when there is nothing to send.
 *
 * One header with `; `-separated pairs, which is what RFC 6265 §5.4 asks for; a duplicate name
 * keeps its last value, since that is the one the server most recently set.
 */
export function cookieHeader(cookies: readonly Cookie[]): string | undefined {
  const pairs = new Map<string, string>();
  for (const cookie of cookies) {
    pairs.set(cookie.name, cookie.value);
  }
  const header = [...pairs].map(([name, value]) => `${name}=${value}`).join('; ');
  return header === '' ? undefined : header;
}
