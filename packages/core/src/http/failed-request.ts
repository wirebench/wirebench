import { HttpError, isWirebenchError } from '../errors.js';

/** The most body bytes a transport error carries: enough to debug a send, small enough to log. */
export const FAILED_REQUEST_BODY_CAP_BYTES = 64 * 1024;

/**
 * The request a transport error was raised for, as it was about to go on the wire: the last
 * attempt's URL and method (after any redirects), its final headers (credentials applied, plus the
 * `host` and `content-length` the transport adds) and at most {@link FAILED_REQUEST_BODY_CAP_BYTES}
 * of its body. Unredacted — whoever shows it must redact it.
 */
export interface FailedRequest {
  readonly url: string;
  readonly method: string;
  readonly headers: Readonly<Record<string, string>>;
  /** Absent when the attempt had no body. */
  readonly bodyBase64?: string;
  /** True when the body was longer than the cap and `bodyBase64` holds only its start. */
  readonly bodyTruncated: boolean;
}

/** Builds the {@link FailedRequest} for one attempt, capping its body. */
export function failedRequestFor(
  url: string,
  method: string,
  headers: Readonly<Record<string, string>>,
  body: Uint8Array | undefined,
): FailedRequest {
  if (body === undefined || body.length === 0) {
    return { url, method, headers: { ...headers }, bodyTruncated: false };
  }
  const truncated = body.length > FAILED_REQUEST_BODY_CAP_BYTES;
  const kept = truncated ? body.subarray(0, FAILED_REQUEST_BODY_CAP_BYTES) : body;
  return {
    url,
    method,
    headers: { ...headers },
    bodyBase64: Buffer.from(kept.buffer, kept.byteOffset, kept.byteLength).toString('base64'),
    bodyTruncated: truncated,
  };
}

/**
 * Returns an `HttpError` with `details.request` set to `request` — a new one with the same code,
 * message and cause, since `details` is read-only. Anything that is not an `HttpError` is
 * returned as is.
 */
export function withFailedRequest(error: unknown, request: FailedRequest): unknown {
  if (!(error instanceof HttpError) || error.details?.['request'] !== undefined) {
    return error;
  }
  const rebuilt = new HttpError(error.code, error.message, {
    ...(error.cause !== undefined ? { cause: error.cause } : {}),
    details: { ...error.details, request },
  });
  if (error.stack !== undefined) rebuilt.stack = error.stack;
  return rebuilt;
}

/** The request a transport error was raised for, or `undefined` when it carries none (e.g. `invalid-url`). */
export function failedRequestOf(error: unknown): FailedRequest | undefined {
  if (!isWirebenchError(error)) return undefined;
  const candidate = error.details?.['request'];
  if (candidate === null || typeof candidate !== 'object') return undefined;
  const { url, method, headers } = candidate as Partial<FailedRequest>;
  if (typeof url !== 'string' || typeof method !== 'string' || headers === null || typeof headers !== 'object') {
    return undefined;
  }
  return candidate as FailedRequest;
}
