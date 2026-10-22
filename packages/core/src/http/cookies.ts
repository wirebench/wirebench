/**
 * The cookies a response sets: what one is, and how every `Set-Cookie` header is read.
 *
 * In `http/` because a sequence's transfers read a response's cookies whatever protocol sent the
 * request, and core imports no protocol folder (protocol modules spec §7.2). `rest/response.ts`
 * re-exports both names. The jar's types live here for the same reason; the jar itself is
 * `rest/cookie-jar.ts`.
 */

/** One cookie a response set, with the attributes it declared. */
export interface Cookie {
  readonly name: string;
  readonly value: string;
  readonly domain?: string;
  readonly path?: string;
  /** As declared, in ISO form when it could be parsed; absent for a session cookie. */
  readonly expires?: string;
  readonly maxAge?: number;
  readonly secure?: boolean;
  readonly httpOnly?: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Set when the header could not be parsed as a cookie; `name` then holds the whole line. */
  readonly malformed?: boolean;
}

/**
 * One cookie the jar holds (cookie jar spec §1.1). Its identity is `(name, domain, path)`; the
 * response-side {@link Cookie} becomes one only when the jar stores it, because only then is the
 * request URL known.
 */
export interface StoredCookie {
  readonly name: string;
  readonly value: string;
  /** The Domain attribute (no leading dot), or the request host for a host-only cookie. */
  readonly domain: string;
  /** True when the response gave no Domain: the cookie goes back to that exact host only. */
  readonly hostOnly: boolean;
  /** The Path attribute, or the default path of the URL that set it (RFC 6265 §5.1.4). */
  readonly path: string;
  /** Absolute expiry in epoch ms, from Max-Age first and then Expires; absent for a session cookie. */
  readonly expiresAt?: number;
  readonly secure: boolean;
  readonly httpOnly: boolean;
  readonly sameSite?: 'Strict' | 'Lax' | 'None';
  /** Epoch ms when first stored; kept when a later response replaces the value (§5.3 step 11). */
  readonly createdAt: number;
}

/** What names one stored cookie. */
export interface CookieKey {
  readonly name: string;
  readonly domain: string;
  readonly path: string;
}

/** Why the jar did not store a cookie a response set. */
export type CookieRejection =
  'deleted' | 'domain-mismatch' | 'domain-not-allowed' | 'secure-over-http' | 'too-large' | 'malformed';

/** The jar's verdict on one cookie a response set. */
export type CookieVerdict = { readonly stored: true } | { readonly stored: false; readonly reason: CookieRejection };

/**
 * What a host lends a send for its cookies (cookie jar spec §1.4): every REST send reports what each
 * response set, redirect hops included, and a request whose `sendCookies` is on carries what the jar
 * matches for each hop's URL. Here, in core, so `run/host.ts` can name it without importing `rest/`.
 */
export interface CookieJarHost {
  /** The jar cookies a request to `url` would carry, in RFC 6265 §5.4 order. */
  cookiesFor(url: string): readonly StoredCookie[];
  /** Stores what a response to `url` set; one verdict per cookie, in order. */
  remember(url: string, cookies: readonly Cookie[]): readonly CookieVerdict[];
}

/**
 * Parses every `Set-Cookie` header of a response (RFC 6265 §5.2).
 *
 * `rawHeaders` rather than the merged map, because several cookies arrive as several headers and
 * joining them with `, ` — which is what merging does — makes them unparseable. A line that is not
 * a cookie at all is kept as `malformed` instead of dropped: it is evidence about the server.
 */
export function parseSetCookie(rawHeaders: readonly (readonly [string, string])[]): Cookie[] {
  const cookies: Cookie[] = [];
  for (const [name, value] of rawHeaders) {
    if (name.toLowerCase() !== 'set-cookie') {
      continue;
    }
    cookies.push(parseOne(value));
  }
  return cookies;
}

function parseOne(header: string): Cookie {
  const parts = header.split(';');
  const pair = parts[0] ?? '';
  const equals = pair.indexOf('=');
  if (equals <= 0) {
    return { name: header.trim(), value: '', malformed: true };
  }
  const cookie: {
    name: string;
    value: string;
    domain?: string;
    path?: string;
    expires?: string;
    maxAge?: number;
    secure?: boolean;
    httpOnly?: boolean;
    sameSite?: 'Strict' | 'Lax' | 'None';
  } = {
    name: pair.slice(0, equals).trim(),
    value: unquote(pair.slice(equals + 1).trim()),
  };

  for (const attribute of parts.slice(1)) {
    const split = attribute.indexOf('=');
    const key = (split === -1 ? attribute : attribute.slice(0, split)).trim().toLowerCase();
    const attributeValue = split === -1 ? '' : attribute.slice(split + 1).trim();
    switch (key) {
      case 'domain':
        // A leading dot is legal and means the same as its absence (RFC 6265 §5.2.3).
        cookie.domain = attributeValue.replace(/^\./, '').toLowerCase();
        break;
      case 'path':
        cookie.path = attributeValue;
        break;
      case 'expires': {
        const date = new Date(attributeValue);
        cookie.expires = Number.isNaN(date.getTime()) ? attributeValue : date.toISOString();
        break;
      }
      case 'max-age': {
        const seconds = Number.parseInt(attributeValue, 10);
        if (!Number.isNaN(seconds)) {
          cookie.maxAge = seconds;
        }
        break;
      }
      case 'secure':
        cookie.secure = true;
        break;
      case 'httponly':
        cookie.httpOnly = true;
        break;
      case 'samesite': {
        const normalized = attributeValue.toLowerCase();
        cookie.sameSite = normalized === 'strict' ? 'Strict' : normalized === 'none' ? 'None' : 'Lax';
        break;
      }
      default:
        break;
    }
  }
  return cookie;
}

/** Strips one layer of double quotes from a cookie value, which some servers add. */
function unquote(value: string): string {
  return value.length > 1 && value.startsWith('"') && value.endsWith('"') ? value.slice(1, -1) : value;
}
