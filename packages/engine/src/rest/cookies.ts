/**
 * Which of a response's cookies go back out on the next send of the same request.
 *
 * Wirebench keeps no cookie jar: a request remembers what its own last response set, for the
 * session only, and sends the matching ones when its *send cookies* setting is on. That is a
 * deliberate limit rather than an unfinished one — a shared jar makes one request's send depend on
 * another's, which is exactly what makes a saved request stop being reproducible — and nothing here
 * ever reaches disk.
 *
 * Matching follows RFC 6265 §5.1.3 and §5.1.4 (domain-match and path-match) and §5.3 (expiry).
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

/** Options for {@link cookiesToSend}. */
export interface CookieMatchOptions {
  /** When the cookies were received, for a `Max-Age` that is relative to that moment. */
  readonly setAt?: Date;
}

/**
 * The cookies of `cookies` that a request to `url` should carry at `now`.
 *
 * A cookie with no `Domain` is host-only, so it goes back only to the host that set it — which, for
 * a per-request memory, is the host it was sent from unless the URL changed. `Secure` cookies never
 * travel over plain HTTP, malformed lines are never sent at all, and an expired cookie is dropped
 * rather than sent and rejected.
 */
export function cookiesToSend(
  cookies: readonly Cookie[],
  url: string,
  now: Date = new Date(),
  options: CookieMatchOptions = {},
): Cookie[] {
  let target: URL;
  try {
    target = new URL(url);
  } catch {
    return [];
  }
  const secureContext = target.protocol === 'https:';
  const requestPath = target.pathname === '' ? '/' : target.pathname;

  return cookies.filter((cookie) => {
    if (cookie.malformed === true || cookie.name === '') {
      return false;
    }
    if (cookie.secure === true && !secureContext) {
      return false;
    }
    if (isExpired(cookie, now, options.setAt)) {
      return false;
    }
    if (cookie.domain !== undefined && !domainMatches(target.hostname, cookie.domain)) {
      return false;
    }
    return pathMatches(requestPath, cookie.path ?? defaultPath(requestPath));
  });
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
