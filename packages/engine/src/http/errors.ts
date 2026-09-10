import { HttpError } from '../errors.js';
import type { HttpErrorCode } from './types.js';

/** Node/undici error codes recognized as TLS/certificate failures. */
const TLS_CODE_PATTERNS = [
  /^CERT_/,
  /^ERR_TLS_/,
  /^ERR_SSL_/,
  /^DEPTH_ZERO_SELF_SIGNED_CERT$/,
  /^UNABLE_TO_VERIFY_LEAF_SIGNATURE$/,
  /^SELF_SIGNED_CERT_IN_CHAIN$/,
];

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

/** Node error codes that indicate a connection-level failure (occur during connect, before any bytes flow). */
const CONNECT_FAILURE_CODES = new Set(['ECONNREFUSED', 'ENOTFOUND', 'EAI_AGAIN', 'ECONNRESET']);

/** True if `err`'s name or message mentions "Proxy" (undici's proxy-related errors do this). */
function looksLikeProxyError(err: unknown): boolean {
  if (!(err instanceof Error)) return false;
  return /proxy/i.test(err.name) || /proxy/i.test(err.message);
}

/**
 * Maps a raw error thrown by undici/Node's networking stack (or our own deadline
 * timer) into a stable {@link HttpError} with an {@link HttpErrorCode}. `userAborted`
 * distinguishes a caller-triggered abort from the deadline timer firing so we can
 * report `aborted` vs `timeout` correctly even though both surface as AbortError.
 * `hadProxy` (the request had `proxy` set) is used to route connection-level
 * failures and undici's proxy errors to the `proxy` code instead of `connection-refused`/`network`.
 */
export function toHttpError(
  err: unknown,
  options: { readonly userAborted: boolean; readonly deadlineHit: boolean; readonly hadProxy?: boolean },
): HttpError {
  const code = nodeErrorCode(err);

  if (options.deadlineHit) {
    return new HttpError('timeout' satisfies HttpErrorCode, 'The request timed out.', optionsFor(err, code));
  }
  if (options.userAborted || isAbortError(err)) {
    return new HttpError('aborted' satisfies HttpErrorCode, 'The request was aborted.', optionsFor(err, code));
  }
  if (
    options.hadProxy === true &&
    ((code !== undefined && CONNECT_FAILURE_CODES.has(code)) || looksLikeProxyError(err))
  ) {
    return new HttpError('proxy' satisfies HttpErrorCode, 'Proxy connection failed.', optionsFor(err, code));
  }
  if (code === 'ECONNREFUSED') {
    return new HttpError('connection-refused' satisfies HttpErrorCode, 'Connection refused.', optionsFor(err, code));
  }
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return new HttpError('dns' satisfies HttpErrorCode, 'DNS lookup failed.', optionsFor(err, code));
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
