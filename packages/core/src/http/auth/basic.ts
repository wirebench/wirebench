/**
 * HTTP Basic authentication (RFC 7617) plus the `WWW-Authenticate` parsing needed to
 * recognise a 401 challenge. Pure string work — the send path owns the retry.
 */

import { headerValue } from '../headers.js';

/** One parsed `WWW-Authenticate` challenge: a lower-cased scheme and its (lower-cased) parameter names. */
export interface AuthChallenge {
  readonly scheme: string;
  readonly params: Readonly<Record<string, string>>;
}

/**
 * Builds the `Authorization` header value for Basic credentials: `Basic base64(user:password)`
 * with the credentials encoded as UTF-8 (RFC 7617's `charset` parameter is only ever `UTF-8`).
 *
 * @param username the user id; must not contain a colon per RFC 7617
 * @param password the password; colons are fine, only the first colon separates
 */
export function basicAuthorization(username: string, password: string): string {
  return `Basic ${Buffer.from(`${username}:${password}`, 'utf-8').toString('base64')}`;
}

/**
 * Tolerantly parses a `WWW-Authenticate` header into its challenges. Real servers send
 * several challenges in one header, quote (or fail to quote) parameter values, and use any
 * casing they like, so this favours recovering what it can over strict RFC 7235 grammar.
 * A `token68` credential after the scheme (as NTLM sends) yields the scheme with no params.
 *
 * @param header the raw header value, or `undefined` when the response had none
 */
export function parseWwwAuthenticate(header: string | undefined): readonly AuthChallenge[] {
  if (header === undefined || header.trim() === '') {
    return [];
  }
  const challenges: { scheme: string; params: Record<string, string> }[] = [];
  // One regex pass over the header: either `name=value` (quoted or not) belonging to the
  // current challenge, or a bare token that starts a new one.
  const token = /([A-Za-z0-9!#$%&'*+\-.^_`|~]+)\s*=\s*("(?:[^"\\]|\\.)*"|[^,\s]*)|([A-Za-z0-9!#$%&'*+\-.^_`|~/=]+)/g;
  let match: RegExpExecArray | null;
  let lastEnd = 0;
  while ((match = token.exec(header)) !== null) {
    const [, name, rawValue, bare] = match;
    const separated = header.slice(lastEnd, match.index).includes(',');
    lastEnd = match.index + match[0].length;
    if (name !== undefined && rawValue !== undefined) {
      const current = challenges[challenges.length - 1];
      if (current === undefined) {
        continue;
      }
      const value =
        rawValue.startsWith('"') && rawValue.endsWith('"') && rawValue.length >= 2
          ? rawValue.slice(1, -1).replace(/\\(.)/g, '$1')
          : rawValue;
      current.params[name.toLowerCase()] = value;
    } else if (bare !== undefined) {
      if (!separated && challenges.length > 0) {
        // A bare token right after a scheme is its `token68` credential (NTLM), not a new scheme.
        continue;
      }
      challenges.push({ scheme: bare.toLowerCase(), params: {} });
    }
  }
  return challenges;
}

/**
 * True when `response` is a 401 offering a `Basic` challenge — the signal that a
 * non-preemptive Basic send should retry once with an `Authorization` header.
 *
 * @param response the status and (case-insensitive) headers of the response to inspect
 */
export function isBasicChallenge(response: {
  readonly status: number;
  readonly headers: Readonly<Record<string, string>>;
}): boolean {
  if (response.status !== 401) {
    return false;
  }
  return parseWwwAuthenticate(headerValue(response.headers, 'www-authenticate')).some(
    (challenge) => challenge.scheme === 'basic',
  );
}
