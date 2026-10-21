/**
 * What a failed definition fetch says (#732 X14): the HTTP status, the sign-in, the certificate or the
 * network cause, and what to try. "Failed to fetch root document" alone left the user guessing.
 */

import { HttpError } from '../errors.js';
import { toHttpError } from '../http/errors.js';

/** The reason phrases worth naming; any other status is named by its number alone. */
const REASONS: Readonly<Record<number, string>> = {
  400: 'Bad Request',
  401: 'Unauthorized',
  403: 'Forbidden',
  404: 'Not Found',
  405: 'Method Not Allowed',
  407: 'Proxy Authentication Required',
  408: 'Request Timeout',
  410: 'Gone',
  429: 'Too Many Requests',
  500: 'Internal Server Error',
  502: 'Bad Gateway',
  503: 'Service Unavailable',
  504: 'Gateway Timeout',
};

/** The first value in `error`'s cause chain that carries a Node `code` (`ENOTFOUND`, `CERT_HAS_EXPIRED`). */
function withNodeCode(error: unknown): unknown {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const code = (current as { code?: unknown }).code;
    if (typeof code === 'string' && /^[A-Z_]+$/.test(code)) return current;
    current = (current as { cause?: unknown }).cause;
  }
  return error;
}

/** The HTTP status a fetcher put on its error, if it got that far. */
function statusOf(error: unknown): number | undefined {
  let current: unknown = error;
  for (let depth = 0; depth < 5 && current !== null && typeof current === 'object'; depth += 1) {
    const details = (current as { details?: { status?: unknown } }).details;
    if (typeof details?.status === 'number') return details.status;
    current = (current as { cause?: unknown }).cause;
  }
  return undefined;
}

/** The host of `location`, for naming it; the location itself when it is not a URL. */
function hostOf(location: string): string {
  try {
    return new URL(location).host || location;
  } catch {
    return location;
  }
}

/** One or two sentences saying why `location` could not be fetched, and what to try. */
export function describeFetchFailure(cause: unknown, location: string): string {
  const status = statusOf(cause);
  if (status !== undefined) {
    const reason = REASONS[status];
    const answered = `The server answered ${String(status)}${reason !== undefined ? ` ${reason}` : ''}`;
    if (status === 401 || status === 403) {
      return `${answered}: it wants a sign-in. Set a user name and password under Authentication, then import again.`;
    }
    if (status === 407) return `${answered}: the proxy wants a sign-in. Check the proxy settings.`;
    if (status === 404 || status === 410) {
      return `${answered} for ${location}. Check the URL: a service's WSDL is often at its address with ?wsdl.`;
    }
    if (status >= 500) return `${answered}. The service may be down; try again later, or check the URL.`;
    return `${answered} for ${location}. Check the URL.`;
  }

  if (location.startsWith('file:')) {
    const code = (withNodeCode(cause) as { code?: unknown }).code;
    if (code === 'ENOENT') return `There is no file at ${location}.`;
    if (code === 'EACCES' || code === 'EPERM') return `The file at ${location} cannot be read: permission denied.`;
  }

  const host = hostOf(location);
  const classified =
    cause instanceof HttpError && cause.code !== 'fetch-failed' && cause.code !== 'network'
      ? cause
      : toHttpError(withNodeCode(cause), { userAborted: false, deadlineHit: false, host });
  switch (classified.code) {
    case 'dns':
      return `${host} could not be found. Check the address, or whether a VPN is needed.`;
    case 'connection-refused':
      return `Nothing answered at ${host}: the connection was refused. Check the address and port, and that the service is running.`;
    case 'timeout':
      return `${host} did not answer in time. Check the address, or try again later.`;
    case 'tls-untrusted':
      return classified.message;
    case 'tls': {
      const code = (classified.details as { code?: unknown } | undefined)?.code;
      return `The secure connection to ${host} failed${typeof code === 'string' ? ` (${code})` : ''}. Check that the address uses the right scheme and port.`;
    }
    case 'proxy':
      return `${classified.message} Check the proxy settings.`;
    default:
      return `${location} could not be fetched: ${classified.message}`;
  }
}
