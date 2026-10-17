import { HttpError } from '../errors.js';
import type { HttpErrorCode } from './types.js';

/**
 * The verification failures that mean "the chain did not lead to a trusted root" — as opposed
 * to a protocol or handshake failure. These are the ones a CA bundle (or the endpoint's
 * "Trust invalid certificates" flag) actually fixes, so they get their own code and their own
 * remedy-shaped message.
 */
const UNTRUSTED_CODES = new Set([
  'UNABLE_TO_VERIFY_LEAF_SIGNATURE',
  'SELF_SIGNED_CERT_IN_CHAIN',
  'DEPTH_ZERO_SELF_SIGNED_CERT',
  'UNABLE_TO_GET_ISSUER_CERT',
  'UNABLE_TO_GET_ISSUER_CERT_LOCALLY',
  'CERT_UNTRUSTED',
]);

/** Node/undici error codes recognized as TLS/certificate failures. */
const TLS_CODE_PATTERNS = [
  /^CERT_/,
  /^ERR_TLS_/,
  /^ERR_SSL_/,
  /^DEPTH_ZERO_SELF_SIGNED_CERT$/,
  /^UNABLE_TO_VERIFY_LEAF_SIGNATURE$/,
  /^SELF_SIGNED_CERT_IN_CHAIN$/,
];

/**
 * The peer's subject DN, when Node attached the offending certificate to the error (it does,
 * for every verification failure raised by `tls.connect`). Rendered `CN=x, O=y` in the
 * certificate's own attribute order, matching `PeerCert.subject`, so the problem row and the
 * SSL inspector name the same thing. `undefined` when the error carries no certificate.
 */
function peerSubjectOf(err: unknown): string | undefined {
  const chain: unknown[] = [err];
  for (let depth = 0; depth < 4 && chain.length > 0; depth += 1) {
    const current = chain.shift();
    if (current === null || typeof current !== 'object') continue;
    const cert = (current as { cert?: unknown }).cert;
    if (cert !== null && typeof cert === 'object') {
      const subject = (cert as { subject?: unknown }).subject;
      if (subject !== null && typeof subject === 'object') {
        const parts: string[] = [];
        for (const [key, value] of Object.entries(subject as Record<string, unknown>)) {
          if (Array.isArray(value)) {
            for (const item of value) parts.push(`${key}=${String(item)}`);
          } else {
            parts.push(`${key}=${String(value)}`);
          }
        }
        if (parts.length > 0) return parts.join(', ');
      }
    }
    chain.push((current as { cause?: unknown }).cause);
  }
  return undefined;
}

/** Extracts a Node-style `code` (e.g. `ECONNREFUSED`) from an arbitrary thrown value, if any. */
function nodeErrorCode(err: unknown): string | undefined {
  if (err !== null && typeof err === 'object' && 'code' in err) {
    const code = (err as { code?: unknown }).code;
    if (typeof code === 'string') return code;
  }
  return undefined;
}

/** True if `err` (or its cause chain) was raised because of an AbortSignal firing. */
function isAbortError(err: unknown): boolean {
  if (err instanceof Error && err.name === 'AbortError') return true;
  if (err !== null && typeof err === 'object' && 'code' in err) {
    return (err as { code?: unknown }).code === 'ABORT_ERR';
  }
  return false;
}

/** Builds `HttpError` constructor options, omitting `details` entirely when there's no code. */
function optionsFor(
  cause: unknown,
  code: string | undefined,
): { readonly cause: unknown; readonly details?: Readonly<Record<string, unknown>> } {
  return code !== undefined ? { cause, details: { code } } : { cause };
}

/**
 * `host:port` a refused connection was aimed at, so the message can name what to check. `host` is a
 * URL's `host`, which leaves out a default port; `port` puts it back.
 */
function targetOf(host: string | undefined, port: number | undefined): string | undefined {
  if (host === undefined) return undefined;
  return port === undefined || /:\d+$/.test(host) ? host : `${host}:${String(port)}`;
}

/** Node error codes that indicate a connection-level failure (occur during connect, before any bytes flow). */
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);

/** True if `err`'s name or message mentions "Proxy" (undici's proxy-related errors do this). */
function looksLikeProxyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /proxy/i.test(err.name) || /proxy/i.test(err.message);
}

/**
 * The status the proxy answered a CONNECT with, when undici refused the tunnel
 * (`Proxy response (407) !== 200 when HTTP Tunneling`). `undefined` for any other error.
 */
function proxyStatusOf(err: unknown): number | undefined {
  if (!(err instanceof Error)) return undefined;
  const match = /Proxy response \((\d{3})\)/i.exec(err.message);
  return match?.[1] === undefined ? undefined : Number(match[1]);
}

/** The `proxy` HttpError, carrying the proxy's CONNECT status as `details.proxyStatus` when known. */
function proxyError(err: unknown, code: string | undefined): HttpError {
  const base = optionsFor(err, code);
  const proxyStatus = proxyStatusOf(err);
  return new HttpError(
    'proxy' satisfies HttpErrorCode,
    'Proxy connection failed.',
    proxyStatus === undefined ? base : { ...base, details: { ...base.details, proxyStatus } },
  );
}

/**
 * Maps a raw error thrown by undici/Node's networking stack (or our own deadline
 * timer) into a stable {@link HttpError} with an {@link HttpErrorCode}. `userAborted`
 * distinguishes a caller-triggered abort from the deadline timer firing so we can
 * report `aborted` vs `timeout` correctly even though both surface as AbortError.
 * `hadProxy` (the request had `proxy` set) is used to route connection-level
 * failures and undici's proxy errors to the `proxy` code instead of `connection-refused`/`network`.
 * `host` names the peer in a `tls-untrusted` message when Node did not attach the offending
 * certificate to the error (undici's connector usually does not), so the user is always told
 * *which* server they are being asked to trust. A refused connection carries `host:port` as
 * `details.target`, and a failed lookup the host name as `details.host`, for the same reason.
 */
export function toHttpError(
  err: unknown,
  options: {
    readonly userAborted: boolean;
    readonly deadlineHit: boolean;
    readonly hadProxy?: boolean;
    readonly host?: string;
    /** The port the request went to, for a `host` that leaves a default port out. */
    readonly port?: number;
    /** The limit the deadline enforced; a `timeout` carries it as `details.timeoutMs` so the app can name it. */
    readonly timeoutMs?: number;
  },
): HttpError {
  const code = nodeErrorCode(err);

  if (options.deadlineHit) {
    const base = optionsFor(err, code);
    return new HttpError(
      'timeout' satisfies HttpErrorCode,
      'The request timed out.',
      options.timeoutMs === undefined ? base : { ...base, details: { ...base.details, timeoutMs: options.timeoutMs } },
    );
  }
  // undici refuses a CONNECT tunnel the proxy did not answer with 200 (a 407 for wrong or missing
  // credentials, say) by aborting the request, so the error is an AbortError the user never caused.
  // It is a proxy failure, and must not read as the user's own Cancel.
  if (options.hadProxy === true && !options.userAborted && looksLikeProxyError(err)) {
    return proxyError(err, code);
  }
  if (options.userAborted || isAbortError(err)) {
    return new HttpError('aborted' satisfies HttpErrorCode, 'The request was aborted.', optionsFor(err, code));
  }
  if (
    options.hadProxy === true &&
    ((code !== undefined && CONNECT_FAILURE_CODES.has(code)) || looksLikeProxyError(err))
  ) {
    return proxyError(err, code);
  }
  if (code === 'ECONNREFUSED') {
    const base = optionsFor(err, code);
    const target = targetOf(options.host, options.port);
    return new HttpError(
      'connection-refused' satisfies HttpErrorCode,
      'Connection refused.',
      target === undefined ? base : { ...base, details: { ...base.details, target } },
    );
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    const base = optionsFor(err, code);
    const host = options.host?.replace(/:\d+$/, '');
    return new HttpError(
      'dns' satisfies HttpErrorCode,
      'DNS lookup failed.',
      host === undefined ? base : { ...base, details: { ...base.details, host } },
    );
  }
  if (code !== undefined && UNTRUSTED_CODES.has(code)) {
    const peerSubject = peerSubjectOf(err);
    const peer = peerSubject ?? options.host;
    return new HttpError(
      'tls-untrusted' satisfies HttpErrorCode,
      `The server certificate${peer === undefined ? '' : ` for ${peer}`} is not trusted. Add its CA to the CA bundle, or turn on "Trust invalid certificates" for this endpoint.`,
      {
        cause: err,
        details: {
          code,
          ...(peerSubject !== undefined ? { peerSubject } : {}),
          ...(options.host !== undefined ? { host: options.host } : {}),
        },
      },
    );
  }
  if (code !== undefined && TLS_CODE_PATTERNS.some((pattern) => pattern.test(code))) {
    return new HttpError('tls' satisfies HttpErrorCode, 'TLS/certificate error.', optionsFor(err, code));
  }
  return new HttpError(
    'network' satisfies HttpErrorCode,
    err instanceof Error ? err.message : 'Network error.',
    optionsFor(err, code),
  );
}

/** Builds the `HttpError('invalid-url')` thrown when `req.url` cannot be parsed. */
export function invalidUrlError(url: string, cause: unknown): HttpError {
  return new HttpError('invalid-url' satisfies HttpErrorCode, `Invalid URL: ${url}`, { cause, details: { url } });
}

/** Builds the `HttpError('too-many-redirects')` thrown when the redirect cap is exceeded. */
export function tooManyRedirectsError(maxRedirects: number): HttpError {
  return new HttpError('too-many-redirects' satisfies HttpErrorCode, `Exceeded maximum of ${maxRedirects} redirects.`, {
    details: { maxRedirects },
  });
}
