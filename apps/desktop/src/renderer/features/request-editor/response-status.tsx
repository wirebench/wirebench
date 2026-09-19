import type {
  ExchangeSummary,
  GrpcExchangeSummary,
  RestExchangeSummary,
  WsHandshakeExchangeSummary,
} from '../../../shared/wire-types.js';
import type { IpcError } from '../../../shared/ipc.js';
import { base64ByteLength, formatBytes, formatDuration } from '../../lib/format-size.js';

/** How a finished exchange should read: fine, or something went wrong. */
export type ExchangeTone = 'ok' | 'bad';

/**
 * A finished exchange of either protocol, as far as the status line and the HTTP Log care.
 *
 * The three request/response summaries carry the `http` exchange and the duration; only a SOAP one
 * can carry a fault. A WebSocket handshake row carries neither — `request.openWs` logs it the
 * moment the handshake settles, always a success (a refused one is a failure row instead) — so it
 * is handled on its own wherever the others read `.http`. The log is a protocol-neutral surface, so
 * the two helpers below take this rather than the SOAP shape.
 */
export type AnyExchangeSummary =
  ExchangeSummary | RestExchangeSummary | GrpcExchangeSummary | WsHandshakeExchangeSummary;

/** A fault, a 4xx, a 5xx, or a gRPC status other than OK is a failure regardless of what the rest says. */
export function toneFor(exchange: AnyExchangeSummary): ExchangeTone {
  if ('protocol' in exchange) {
    // Only ever logged for a handshake that completed (status 101); a refused one is a failure row.
    return 'ok';
  }
  const fault = 'response' in exchange ? exchange.response?.fault : undefined;
  const grpcFailed = 'statusName' in exchange && exchange.status !== 0;
  return fault !== undefined || grpcFailed || exchange.http.status >= 400 ? 'bad' : 'ok';
}

/** Decoded response body size in bytes — what the header line and the log's size column show. */
export function responseSize(exchange: AnyExchangeSummary): number {
  if ('protocol' in exchange) {
    // A handshake row has no body of its own; the session's frames are not "the response".
    return 0;
  }
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
      {formatDuration(exchange.durationMs)}
      {' · '}
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
