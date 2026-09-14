/**
 * The response pane's header line: what came back, how long it took and how big it was.
 *
 * The status is coloured by class rather than by "did it work": a 404 is a perfectly good answer to
 * a request that asked for something absent, so it reads as a client error rather than as a failure
 * of the app. A transport failure has no status at all and replaces the line.
 */
import type { IpcError } from '../../../../shared/ipc.js';
import type { RestExchangeSummary } from '../../../../shared/wire-types.js';
import { base64ByteLength, formatBytes } from '../../../lib/format-size.js';

/** The colour class for a status code, by its class. */
export function statusToneClass(status: number): string {
  if (status >= 500) {
    return 'text-status-danger';
  }
  if (status >= 400) {
    return 'text-status-warning';
  }
  if (status >= 300) {
    return 'text-status-info';
  }
  return 'text-status-success';
}

export interface StatusLineProps {
  readonly exchange?: RestExchangeSummary | undefined;
  readonly error?: IpcError | undefined;
  readonly sending?: boolean;
}

/** The `200 OK · 12 ms · 1.2 KB · HTTP/1.1` line. */
export function StatusLine({ exchange, error, sending = false }: StatusLineProps) {
  if (error !== undefined) {
    return (
      <p
        role="status"
        data-testid="rest-response-status"
        className="truncate px-2 font-mono text-xs text-status-danger"
        title={error.message}
      >
        <span className="font-medium">{error.code}</span> · {error.message}
      </p>
    );
  }
  if (sending) {
    return (
      <p role="status" data-testid="rest-response-status" className="px-2 font-mono text-xs text-fg-muted">
        Sending…
      </p>
    );
  }
  if (exchange === undefined) {
    return null;
  }

  const bodyBytes = base64ByteLength(exchange.http.bodyBase64);
  const totalBytes = base64ByteLength(exchange.http.rawResponseBase64);

  return (
    <p role="status" data-testid="rest-response-status" className="truncate px-2 font-mono text-xs text-fg-muted">
      <span className={`font-medium ${statusToneClass(exchange.http.status)}`}>
        {exchange.http.status} {exchange.http.statusText}
      </span>
      {' · '}
      {Math.round(exchange.durationMs)} ms{' · '}
      {formatBytes(bodyBytes)} body
      {totalBytes > 0 && ` · ${formatBytes(totalBytes)} total`}
      {exchange.http.httpVersion !== undefined && ` · HTTP/${exchange.http.httpVersion}`}
      {exchange.methodChanged && <span className="text-status-warning">{' · redirected as GET'}</span>}
      {exchange.http.truncated === true && <span className="text-status-warning">{' · truncated'}</span>}
    </p>
  );
}
