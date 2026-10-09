/**
 * Where a handshake's later legs go when leg 1 followed a redirect before the server challenged (#266).
 *
 * Leg 1 is the caller's request with redirects followed, so the challenge can come from a hop other than
 * the request's own URL. The token is made for, and sent to, that hop: repeating the original URL would
 * send it through the redirect again. A hop on another origin gets nothing: credentials never cross
 * origins, so the send fails with an error naming the hop rather than with a misleading refusal. The one
 * exception is the same host over TLS when leg 1 was upgraded there (#71): that origin is the request's
 * own from then on.
 */

import { HttpError } from '../../errors.js';
import { withoutHeader } from '../headers.js';
import { upgradedOrigin } from '../https-upgrade.js';
import type { HttpExchange, HttpRequest } from '../types.js';

/**
 * The request the later legs repeat: `request` itself, or, after a redirect, the hop that answered
 * `challenge`, with the method and body that hop received.
 *
 * @throws HttpError `<scheme>-cross-origin` when that hop is on another origin than `request`
 */
export function challengedRequest(
  request: HttpRequest,
  challenge: HttpExchange,
  scheme: 'kerberos' | 'ntlm',
): HttpRequest {
  if (challenge.redirects.length === 0) return request;
  const hop = challenge.request.url;
  const origin = new URL(request.url).origin;
  if (!ownOrigins(request, challenge).has(new URL(hop).origin)) {
    const name = scheme === 'kerberos' ? 'Kerberos' : 'NTLM';
    const label = hopLabel(hop);
    throw new HttpError(
      `${scheme}-cross-origin`,
      `${label} asked for ${name} after a redirect from ${origin}; ${name} credentials are sent to the request's own origin only.`,
      { details: { url: label, origin } },
    );
  }
  const method = challenge.request.method as HttpRequest['method'];
  if (method === request.method) return { ...request, url: hop };
  // The redirect turned the request into a bodyless GET; the later legs repeat that, as the hop saw it.
  return {
    ...request,
    url: hop,
    method,
    headers: withoutHeader(request.headers, 'content-type'),
    body: new Uint8Array(0),
  };
}

/** The request's origin, and its https one when leg 1 was upgraded from it. */
function ownOrigins(request: HttpRequest, challenge: HttpExchange): ReadonlySet<string> {
  const url = new URL(request.url);
  const upgraded = upgradedOrigin(url);
  const wasUpgraded = challenge.redirects.some((hop) => hop.upgrade === true && new URL(hop.url).origin === url.origin);
  return new Set(upgraded !== undefined && wasUpgraded ? [url.origin, upgraded] : [url.origin]);
}

/** A hop as an error names it: origin and path, without a query that may carry an API key. */
export function hopLabel(url: string): string {
  const parsed = new URL(url);
  return `${parsed.origin}${parsed.pathname}`;
}

/** `final` with the redirects leg 1 followed in front of its own, so the trail to the hop stays visible. */
export function withLegOneRedirects(final: HttpExchange, first: HttpExchange): HttpExchange {
  return first.redirects.length === 0 ? final : { ...final, redirects: [...first.redirects, ...final.redirects] };
}
