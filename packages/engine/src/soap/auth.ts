/**
 * Token credentials on a SOAP send: Bearer, API key and OAuth2 become headers or a query
 * parameter, exactly as on a REST send, so there is one implementation of each ({@link applyAuth}).
 *
 * Basic and NTLM are passed through as `transportAuth`, because they may need a challenge round
 * trip that only the transport (`http/auth/*`) can run.
 */

import { applyAuth } from '../rest/auth.js';
import type { SendAuth } from '../types.js';

/** A SOAP send's endpoint and headers with token credentials applied. */
export interface SoapAppliedAuth {
  /** The endpoint to put on the wire: the input one, plus an API key's query parameter if any. */
  readonly endpoint: string;
  /** The caller's headers plus any credential header they did not already set. */
  readonly headers: Readonly<Record<string, string>>;
  /** Basic or NTLM, for `sendWithAuth`; absent for token schemes and for no auth. */
  readonly transportAuth?: SendAuth;
}

/**
 * Applies resolved credentials to one SOAP send.
 *
 * A header the caller set wins over the credential's, compared case-insensitively, so a request
 * that writes its own `Authorization` keeps it — the same rule the REST send and the Basic
 * transport follow. An endpoint that does not parse as a URL is returned unchanged: the send
 * then fails on the URL itself, which is the clearer error.
 */
export function applySoapAuth(
  endpoint: string,
  headers: Readonly<Record<string, string>> | undefined,
  auth: SendAuth | undefined,
): SoapAppliedAuth {
  const applied = applyAuth(auth);
  const merged: Record<string, string> = { ...headers };
  const taken = new Set(Object.keys(merged).map((name) => name.toLowerCase()));
  for (const [name, value] of Object.entries(applied.headers)) {
    if (!taken.has(name.toLowerCase())) {
      merged[name] = value;
    }
  }
  return {
    endpoint: withQuery(endpoint, applied.query),
    headers: merged,
    ...(applied.transportAuth !== undefined ? { transportAuth: applied.transportAuth } : {}),
  };
}

/**
 * The endpoint with `rows` appended to its query. Built by hand rather than through
 * `URL.searchParams`, which would re-serialise the whole query as form encoding: the endpoint's own
 * query and fragment stay byte-for-byte as configured (an `?op` stays `?op`), as REST keeps an
 * inline query. An endpoint that is not an absolute URL is returned unchanged.
 */
function withQuery(endpoint: string, rows: readonly { readonly name: string; readonly value: string }[]): string {
  if (rows.length === 0) {
    return endpoint;
  }
  try {
    new URL(endpoint);
  } catch {
    return endpoint;
  }
  const hash = endpoint.indexOf('#');
  const head = hash === -1 ? endpoint : endpoint.slice(0, hash);
  const fragment = hash === -1 ? '' : endpoint.slice(hash);
  const separator = !head.includes('?') ? '?' : /[?&]$/.test(head) ? '' : '&';
  const query = rows.map((row) => `${encodeURIComponent(row.name)}=${encodeURIComponent(row.value)}`).join('&');
  return `${head}${separator}${query}${fragment}`;
}
