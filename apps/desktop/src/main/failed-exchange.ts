/**
 * Builds the `FailedExchangeWire` the console's HTTP Log shows for a send that never produced a
 * response. Called from the same catch blocks that write History (`send-with-history.ts` for SOAP
 * sends and resends, `ipc/request.ts` for REST). When the transport got as far as building the
 * request, the error carries it (`failedRequestOf`), so the row shows the URL, method, headers and
 * body as they were about to go on the wire; otherwise the resolved pre-build request is used.
 *
 * Redaction is unconditional here — `show: false`, whatever the session's show-secrets flag says. A
 * failure is never held in the unredacted `ExchangeCache`, so there is nothing to re-fetch later:
 * what is emitted is what the log will ever show.
 */

import { isWirebenchError, type FailedRequest } from '@wirebench/engine';
import type { FailedExchangeWire } from '../shared/wire-types.js';
import { redactHeaders, redactRawHttp, redactUrl } from './redact.js';

/** What a catch block has at hand for one failed send. */
export interface FailedExchangeInput {
  readonly sendId: string;
  readonly protocol: 'soap' | 'rest' | 'grpc';
  /** Absent for an ad-hoc resend of an orphaned History entry. */
  readonly requestId?: string | undefined;
  readonly url: string;
  readonly method: string;
  /** The request headers as resolved for the send; empty when the failure came before they were built. */
  readonly headers: Readonly<Record<string, string>>;
  /** `Date.now()` when the send started. */
  readonly startedAt: number;
  readonly durationMs: number;
  readonly error: unknown;
  /** Query parameters an API key travels in, masked in the URL whatever they are called. */
  readonly keyParams?: readonly string[] | undefined;
  /**
   * The request the transport was about to put on the wire (`failedRequestOf(error)`), when the
   * failure came after it was built. It overrides `url`, `method` and `headers`, and is the only
   * source of the raw request.
   */
  readonly captured?: FailedRequest | undefined;
  /** `prepare` when the failure came before the request was built; omitted or `send` otherwise. */
  readonly stage?: 'prepare' | 'send' | undefined;
}

/** The `{ code, message }` History records for the same error; `internal-error` for a non-engine one. */
function errorOf(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/** The code a prepare-stage failure is reported under. */
export function prepareFailureCode(error: unknown): string {
  if (error instanceof TypeError && (error as { code?: unknown }).code === 'ERR_INVALID_URL') {
    return 'invalid-url';
  }
  return isWirebenchError(error) ? error.code : 'internal-error';
}

/**
 * The raw request for a captured one, redacted with the same helper a finished exchange's raw
 * request goes through (sensitive header lines, `wsse:Password` in an XML body). The request line
 * is written from the already-redacted URL, since `redactRawHttp` does not look at it. A truncated
 * body is left out: masking a cut-off XML body could miss a password whose closing tag was cut.
 */
function rawRequestOf(captured: FailedRequest, redactedUrl: string): string {
  let target: string;
  try {
    const parsed = new URL(redactedUrl);
    target = `${parsed.pathname}${parsed.search}` || '/';
  } catch {
    target = redactedUrl;
  }
  const lines = [`${captured.method} ${target} HTTP/1.1`];
  for (const [name, value] of Object.entries(captured.headers)) {
    lines.push(`${name}: ${value}`);
  }
  const head = Buffer.from(`${lines.join('\r\n')}\r\n\r\n`, 'latin1');
  const body =
    captured.bodyBase64 !== undefined && !captured.bodyTruncated
      ? Buffer.from(captured.bodyBase64, 'base64')
      : Buffer.alloc(0);
  return redactRawHttp(Buffer.concat([head, body]).toString('base64'), { show: false, encoding: 'base64' });
}

/** The failure row for one send, redacted for good. */
export function failedExchangeOf(input: FailedExchangeInput): FailedExchangeWire {
  const captured = input.captured;
  const url = redactUrl(captured?.url ?? input.url, { show: false, extraParams: input.keyParams ?? [] });
  return {
    sendId: input.sendId,
    protocol: input.protocol,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    request: {
      url,
      method: captured?.method ?? input.method,
      headers: redactHeaders(captured?.headers ?? input.headers, { show: false }),
    },
    ...(captured !== undefined ? { rawRequestBase64: rawRequestOf(captured, url) } : {}),
    startedAt: new Date(input.startedAt).toISOString(),
    durationMs: input.durationMs,
    error:
      input.stage === 'prepare'
        ? { code: prepareFailureCode(input.error), message: errorOf(input.error).message }
        : errorOf(input.error),
    ...(input.stage === 'prepare' ? { stage: 'prepare' as const } : {}),
  };
}
