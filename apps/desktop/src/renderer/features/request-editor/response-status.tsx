import type { ExchangeSummary } from '../../../shared/wire-types.js';
import type { IpcError } from '../../../shared/ipc.js';
import { base64ByteLength, formatBytes } from '../../lib/format-size.js';

/** How a finished exchange should read: fine, or something went wrong. */
export type ExchangeTone = 'ok' | 'bad';

/** A fault, a 4xx, or a 5xx is a failure regardless of what the other two say. */
export function toneFor(exchange: ExchangeSummary): ExchangeTone {
  return exchange.response?.fault !== undefined || exchange.http.status >= 400 ? 'bad' : 'ok';
}

/** Decoded response body size in bytes — what the header line and the log's size column show. */
export function responseSize(exchange: ExchangeSummary): number {
  return base64ByteLength(exchange.http.bodyBase64);
}

const TONE_CLASS: Readonly<Record<ExchangeTone, string>> = {
  ok: 'text-status-success',
  bad: 'text-status-danger',
};

export interface ResponseStatusProps {
  readonly exchange?: ExchangeSummary | undefined;
  readonly error?: IpcError | undefined;
}

/** The response pane's header line: `200 OK · 143 ms · 1.2 KB`, or the send error that replaced it. */
export function ResponseStatus({ exchange, error }: ResponseStatusProps) {
  if (error !== undefined) {
    return (
      <p
        role="status"
        data-testid="response-status"
        className="truncate px-2 font-mono text-xs text-status-danger"
        title={error.message}
      >
        <span className="font-medium">{error.code}</span> · {error.message}
      </p>
    );
  }
  if (exchange === undefined) {
    return null;
  }

  const tone = toneFor(exchange);
  const fault = exchange.response?.fault;

  return (
    <p role="status" data-testid="response-status" className="truncate px-2 font-mono text-xs text-fg-muted">
      <span className={`font-medium ${TONE_CLASS[tone]}`}>
        {exchange.http.status} {exchange.http.statusText}
      </span>
      {' · '}
      {exchange.durationMs} ms{' · '}
      {formatBytes(responseSize(exchange))}
      {fault !== undefined && (
        <span className="text-status-danger">
          {' · '}
          SOAP Fault: {fault.code}
        </span>
      )}
      {exchange.auth?.challenged === true && (
        <span data-testid="auth-challenge-note" className="text-fg-subtle">
          {' · '}
          Authenticated after 401 challenge
        </span>
      )}
      {exchange.http.truncated && <span className="text-status-warning"> · truncated</span>}
    </p>
  );
}
