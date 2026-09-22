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

function withQuery(endpoint: string, rows: readonly { readonly name: string; readonly value: string }[]): string {
  if (rows.length === 0) {
    return endpoint;
  }
  let url: URL;
  try {
    url = new URL(endpoint);
  } catch {
    return endpoint;
  }
  for (const row of rows) {
    url.searchParams.append(row.name, row.value);
  }
  return url.toString();
}
