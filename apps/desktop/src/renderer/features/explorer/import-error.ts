/**
 * What a failed import says (#685 E15). The fetchers' own errors read "GET … failed with status 404": true,
 * and no help. The dialog names the status and the host, says what it means, and suggests what to check.
 */

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

/** The HTTP status an error carries: on its details where main kept them, else in its message. */
function statusOf(error: unknown): number | undefined {
  if (error !== null && typeof error === 'object') {
    const details = (error as { details?: { status?: unknown } }).details;
    if (typeof details?.status === 'number') return details.status;
  }
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : '';
  const match = /\b(?:status|HTTP)\s+(\d{3})\b/i.exec(message);
  return match === null ? undefined : Number(match[1]);
}

/** The host of `location`, for naming it; `undefined` when it is not an http(s) URL. */
function hostOf(location: string): string | undefined {
  try {
    const url = new URL(location);
    return url.protocol === 'http:' || url.protocol === 'https:' ? url.host : undefined;
  } catch {
    return undefined;
  }
}

/** What to check when the cause is not known: the three things that go wrong with an import. */
const GENERAL_HINT = 'Check the URL, the authentication or the format.';

/**
 * One or two sentences for the import dialog: what the server said or what failed, and what to try.
 *
 * @param error - what the import threw
 * @param location - the URL or file the import was asked for; `''` for pasted text
 */
export function describeImportError(error: unknown, location: string): string {
  const message = error instanceof Error ? error.message : typeof error === 'string' ? error : 'Import failed';
  // Main already said it in these words (a WSDL fetch, #732 X14): nothing to add.
  if (/^The server answered \d{3}/.test(message)) return message;

  const status = statusOf(error);
  const host = hostOf(location);
  const where = host === undefined ? '' : ` from ${host}`;
  if (status !== undefined) {
    const reason = REASONS[status];
    const answered = `The server answered ${String(status)}${reason !== undefined ? ` ${reason}` : ''}${where}`;
    if (status === 401 || status === 403) {
      return `${answered}: it wants a sign-in. Set the authentication for this import, then try again.`;
    }
    if (status === 407) return `${answered}: the proxy wants a sign-in. Check the proxy settings.`;
    if (status === 404 || status === 410) return `${answered}. Check the URL: there is no document at ${location}.`;
    if (status >= 500) return `${answered}. The service may be down; try again later, or check the URL.`;
    return `${answered}. ${GENERAL_HINT}`;
  }

  if (host !== undefined) {
    if (/ENOTFOUND|getaddrinfo/i.test(message))
      return `${host} could not be found. Check the address, or whether a VPN is needed.`;
    if (/ECONNREFUSED/i.test(message))
      return `Nothing answered at ${host}: the connection was refused. Check the address and port.`;
    if (/timed out|ETIMEDOUT|timeout/i.test(message))
      return `${host} did not answer in time. Check the address, or try again later.`;
    if (/certificate|CERT_|self.signed|TLS|SSL/i.test(message))
      return `${message} Check the certificate, or add its authority under Settings.`;
  }
  return message.endsWith('.') ? `${message} ${GENERAL_HINT}` : `${message}. ${GENERAL_HINT}`;
}
