/**
 * The cookie jar (cookie jar and current values spec §1): what REST responses set, kept per
 * workspace in the app and per run on the command line, and sent back by requests whose *Send
 * cookies* setting is on.
 *
 * Storing follows RFC 6265 §5.3, and RFC 6265bis §5.6 for Secure. A cookie's identity is its name,
 * domain and path. A newer cookie replaces an older one but keeps its creation time. A cookie that
 * is already expired deletes the stored one instead. There is no public-suffix list: see
 * `docs/security.md`, "The cookie jar".
 */
import type {
  Cookie,
  CookieJarHost,
  CookieKey,
  CookieRejection,
  CookieVerdict,
  StoredCookie,
} from '../http/cookies.js';
import { defaultPath, domainMatches, pathMatches } from './cookies.js';

export type { CookieJarHost, CookieKey, CookieRejection, CookieVerdict, StoredCookie } from '../http/cookies.js';

/** At most this many cookies per domain (spec §1.2). */
export const MAX_COOKIES_PER_DOMAIN = 50;
/** At most this many cookies in one jar. */
export const MAX_COOKIES = 3000;
/** A name plus value over this many UTF-8 bytes is not stored. */
export const MAX_COOKIE_BYTES = 4096;

const IPV4 = /^\d{1,3}(?:\.\d{1,3}){3}$/;
const encoder = new TextEncoder();

/** Strip IPv6 brackets from hostname (URL.hostname keeps them). */
function stripIpv6Brackets(hostname: string): string {
  return hostname.startsWith('[') && hostname.endsWith(']') ? hostname.slice(1, -1) : hostname;
}

function isIpAddress(host: string): boolean {
  return IPV4.test(host) || host.includes(':') || host.startsWith('[');
}

function idOf(key: CookieKey): string {
  return `${key.domain}\n${key.path}\n${key.name}`;
}

/** The desktop wire schema's rules: nothing that would break the `Cookie` header a cookie is sent in. */
const BAD_NAME = /[;=\s\u0000-\u001f\u007f]/;
const BAD_VALUE = /[;\r\n\0]/;

function rejected(reason: CookieRejection): CookieVerdict {
  return { stored: false, reason };
}

/** When `cookie` expires, from Max-Age first and then Expires (§5.3 step 3); undefined for a session cookie. */
function expiresAtOf(cookie: Cookie, now: number): number | undefined {
  if (cookie.maxAge !== undefined) {
    return now + cookie.maxAge * 1000;
  }
  if (cookie.expires === undefined) {
    return undefined;
  }
  const at = Date.parse(cookie.expires);
  return Number.isNaN(at) ? undefined : at;
}

/** The domain a cookie from `host` is stored under, or why it is refused (spec §1.3). */
function scopeOf(
  cookie: Cookie,
  host: string,
): { readonly domain: string; readonly hostOnly: boolean } | CookieRejection {
  const declared = (cookie.domain ?? '').replace(/^\./, '').toLowerCase();
  if (declared === '') {
    return { domain: host, hostOnly: true };
  }
  const restricted = isIpAddress(declared) || !declared.includes('.');
  if (declared === host) {
    // An IP or a single label is honoured only as the host itself, and then only host-only.
    return { domain: host, hostOnly: restricted };
  }
  if (restricted) {
    return 'domain-not-allowed';
  }
  return domainMatches(host, declared) ? { domain: declared, hostOnly: false } : 'domain-mismatch';
}

/** RFC 6265 §5.4 step 2: longer paths first, then the earlier created. */
function sendOrder(a: StoredCookie, b: StoredCookie): number {
  return b.path.length - a.path.length || a.createdAt - b.createdAt;
}

/** Which cookie a full jar lets go first: the soonest to expire (a session cookie last), then the oldest. */
function evictionOrder(a: StoredCookie, b: StoredCookie): number {
  const aExpires = a.expiresAt ?? Number.POSITIVE_INFINITY;
  const bExpires = b.expiresAt ?? Number.POSITIVE_INFINITY;
  if (aExpires !== bExpires) {
    return aExpires < bExpires ? -1 : 1;
  }
  return a.createdAt - b.createdAt;
}

function listOrder(a: StoredCookie, b: StoredCookie): number {
  return a.domain.localeCompare(b.domain) || a.name.localeCompare(b.name) || a.path.localeCompare(b.path);
}

export class CookieJar {
  private readonly cookies = new Map<string, StoredCookie>();

  constructor(initial: readonly StoredCookie[] = []) {
    for (const cookie of initial) {
      this.cookies.set(idOf(cookie), cookie);
    }
  }

  /** Stores what a response to `url` set, at `now`: one verdict per cookie, in order. */
  store(url: string, cookies: readonly Cookie[], now: number): CookieVerdict[] {
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return cookies.map(() => rejected('malformed'));
    }
    return cookies.map((cookie) => this.storeOne(cookie, target, now));
  }

  /** The cookies a request to `url` carries at `now`, in RFC 6265 §5.4 order. */
  cookiesFor(url: string, now: number): StoredCookie[] {
    this.dropExpired(now);
    let target: URL;
    try {
      target = new URL(url);
    } catch {
      return [];
    }
    const host = stripIpv6Brackets(target.hostname).toLowerCase();
    const secureContext = target.protocol === 'https:';
    const path = target.pathname === '' ? '/' : target.pathname;
    return [...this.cookies.values()]
      .filter(
        (cookie) =>
          (cookie.hostOnly ? host === cookie.domain : domainMatches(host, cookie.domain)) &&
          pathMatches(path, cookie.path) &&
          (!cookie.secure || secureContext),
      )
      .sort(sendOrder);
  }

  /** Every unexpired cookie, by domain, then name, then path. */
  list(now: number): StoredCookie[] {
    this.dropExpired(now);
    return [...this.cookies.values()].sort(listOrder);
  }

  /**
   * Stores `cookie` as given, replacing one of the same identity. The manager's edit: the domain and
   * Secure rules are skipped (it picks its own domain), but the jar's size limits still hold.
   */
  set(cookie: StoredCookie, now: number = Date.now()): void {
    if (cookie.name === '' || BAD_NAME.test(cookie.name)) {
      throw new RangeError(
        'A cookie name is not empty and has no whitespace, control character, semicolon or equals sign.',
      );
    }
    if (BAD_VALUE.test(cookie.value)) {
      throw new RangeError('A cookie value has no semicolon, line break or NUL.');
    }
    this.cookies.set(idOf(cookie), cookie);
    this.enforceLimits(cookie.domain, now);
  }

  remove(key: CookieKey): boolean {
    return this.cookies.delete(idOf(key));
  }

  /** Removes every cookie stored under `domain` (lowercased, leading dot ignored); how many went. */
  removeDomain(domain: string): number {
    const target = domain.replace(/^\./, '').toLowerCase();
    let removed = 0;
    for (const [id, cookie] of this.cookies) {
      if (cookie.domain === target) {
        this.cookies.delete(id);
        removed += 1;
      }
    }
    return removed;
  }

  clear(): void {
    this.cookies.clear();
  }

  /** The cookies worth saving: unexpired, with an expiry. */
  persistent(now: number): StoredCookie[] {
    return this.list(now).filter((cookie) => cookie.expiresAt !== undefined);
  }

  private storeOne(cookie: Cookie, target: URL, now: number): CookieVerdict {
    if (cookie.malformed === true || cookie.name === '' || BAD_NAME.test(cookie.name) || BAD_VALUE.test(cookie.value)) {
      return rejected('malformed');
    }
    if (encoder.encode(cookie.name).length + encoder.encode(cookie.value).length > MAX_COOKIE_BYTES) {
      return rejected('too-large');
    }
    const secureContext = target.protocol === 'https:';
    if (cookie.secure === true && !secureContext) {
      return rejected('secure-over-http');
    }
    const host = stripIpv6Brackets(target.hostname).toLowerCase();
    const scope = scopeOf(cookie, host);
    if (typeof scope === 'string') {
      return rejected(scope);
    }
    const declaredPath = cookie.path;
    const path =
      declaredPath !== undefined && declaredPath.startsWith('/') ? declaredPath : defaultPath(target.pathname);
    const id = idOf({ name: cookie.name, domain: scope.domain, path });
    const existing = this.cookies.get(id);
    if (existing?.secure === true && !secureContext) {
      return rejected('secure-over-http');
    }
    // RFC 6265bis §5.3 step 13: refuse a non-Secure cookie if the jar holds a Secure cookie shadowing it
    if (!secureContext && cookie.secure !== true) {
      for (const candidate of this.cookies.values()) {
        if (
          candidate.secure &&
          candidate.name === cookie.name &&
          (domainMatches(candidate.domain, scope.domain) || domainMatches(scope.domain, candidate.domain)) &&
          pathMatches(path, candidate.path)
        ) {
          return rejected('secure-over-http');
        }
      }
    }
    const expiresAt = expiresAtOf(cookie, now);
    if (expiresAt !== undefined && expiresAt <= now) {
      this.cookies.delete(id);
      return rejected('deleted');
    }
    this.cookies.set(id, {
      name: cookie.name,
      value: cookie.value,
      domain: scope.domain,
      hostOnly: scope.hostOnly,
      path,
      ...(expiresAt !== undefined ? { expiresAt } : {}),
      secure: cookie.secure === true,
      httpOnly: cookie.httpOnly === true,
      ...(cookie.sameSite !== undefined ? { sameSite: cookie.sameSite } : {}),
      createdAt: existing?.createdAt ?? now,
    });
    this.enforceLimits(scope.domain, now);
    return { stored: true };
  }

  private dropExpired(now: number): void {
    for (const [id, cookie] of this.cookies) {
      if (cookie.expiresAt !== undefined && cookie.expiresAt <= now) {
        this.cookies.delete(id);
      }
    }
  }

  private enforceLimits(domain: string, now: number): void {
    this.dropExpired(now);
    const inDomain = [...this.cookies.values()].filter((cookie) => cookie.domain === domain);
    this.evict(inDomain, inDomain.length - MAX_COOKIES_PER_DOMAIN);
    this.evict([...this.cookies.values()], this.cookies.size - MAX_COOKIES);
  }

  private evict(candidates: readonly StoredCookie[], count: number): void {
    if (count <= 0) {
      return;
    }
    for (const cookie of [...candidates].sort(evictionOrder).slice(0, count)) {
      this.cookies.delete(idOf(cookie));
    }
  }
}

/** A {@link CookieJarHost} over `jar`, reading the time from `now`. */
export function jarCookieHost(jar: CookieJar, now: () => number = () => Date.now()): CookieJarHost {
  return {
    cookiesFor: (url) => jar.cookiesFor(url, now()),
    remember: (url, cookies) => jar.store(url, cookies, now()),
  };
}

/**
 * The `Cookie` header a request carries: the pairs it sets by hand, then the jar's, in the order
 * given. A jar cookie is left out when a hand-set pair has its name. Unlike `cookieHeader`, two jar
 * cookies of one name on different paths both go, most specific first, as RFC 6265 §5.4 sends them.
 */
export function mergeCookieHeader(
  jarCookies: readonly StoredCookie[],
  handSet: string | undefined,
): string | undefined {
  const hand = (handSet ?? '')
    .split(';')
    .map((pair) => pair.trim())
    .filter((pair) => pair !== '');
  const handNames = new Set(
    hand.map((pair) => {
      const equals = pair.indexOf('=');
      return (equals === -1 ? pair : pair.slice(0, equals)).trim();
    }),
  );
  const pairs = [
    ...hand,
    ...jarCookies.filter((cookie) => !handNames.has(cookie.name)).map((cookie) => `${cookie.name}=${cookie.value}`),
  ];
  return pairs.length === 0 ? undefined : pairs.join('; ');
}

/** Options for {@link cookiesToSend}. */
export interface CookieMatchOptions {
  /** When the cookies were received, for a `Max-Age` that is relative to that moment. */
  readonly setAt?: Date;
}

/**
 * The cookies of `cookies` that a request to `url` should carry at `now`, in the order given. Kept
 * for the engine's public API: each cookie is stored, as received from `url`, in a throwaway jar and
 * kept when that jar would send it back to `url`.
 */
export function cookiesToSend(
  cookies: readonly Cookie[],
  url: string,
  now: Date = new Date(),
  options: CookieMatchOptions = {},
): Cookie[] {
  const storedAt = (options.setAt ?? now).getTime();
  return cookies.filter((cookie) => {
    const jar = new CookieJar();
    jar.store(url, [cookie], storedAt);
    return jar.cookiesFor(url, now.getTime()).length > 0;
  });
}
