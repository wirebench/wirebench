/**
 * Builds the `FailedExchangeWire` the console's HTTP Log shows for a send that never produced a
 * response. Called from the same catch blocks that write History (`send-with-history.ts` for SOAP
 * sends and resends, `ipc/request.ts` for REST), which are the only places that have the resolved
 * request headers a user debugging a proxy or TLS failure needs.
 *
 * Redaction is unconditional here — `show: false`, whatever the session's show-secrets flag says. A
 * failure is never held in the unredacted `ExchangeCache`, so there is nothing to re-fetch later:
 * what is emitted is what the log will ever show.
 */

import { isWirebenchError } from '@wirebench/engine';
import type { FailedExchangeWire } from '../shared/wire-types.js';
import { redactHeaders, redactUrl } from './redact.js';

/** What a catch block has at hand for one failed send. */
export interface FailedExchangeInput {
  readonly sendId: string;
  readonly protocol: 'soap' | 'rest';
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
}

/** The `{ code, message }` History records for the same error; `internal-error` for a non-engine one. */
function errorOf(error: unknown): { code: string; message: string } {
  if (isWirebenchError(error)) {
    return { code: error.code, message: error.message };
  }
  return { code: 'internal-error', message: error instanceof Error ? error.message : String(error) };
}

/** The failure row for one send, redacted for good. */
export function failedExchangeOf(input: FailedExchangeInput): FailedExchangeWire {
  return {
    sendId: input.sendId,
    protocol: input.protocol,
    ...(input.requestId !== undefined ? { requestId: input.requestId } : {}),
    request: {
      url: redactUrl(input.url, { extraParams: input.keyParams ?? [] }),
      method: input.method,
      headers: redactHeaders(input.headers, { show: false }),
    },
    startedAt: new Date(input.startedAt).toISOString(),
    durationMs: input.durationMs,
    error: errorOf(input.error),
  };
}
