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
import type { RestLiveState } from '../../../state/exchanges.js';
import { ContractChip } from './contract-chip.js';

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
  /** An event stream still arriving: its status and running counts, before the exchange exists. */
  readonly live?: RestLiveState | undefined;
}

/** `12 events · last id 7`, the part of the line an event stream adds. */
export function streamCountsText(events: number, lastEventId: string): string {
  const parts = [`${String(events)} event${events === 1 ? '' : 's'}`];
  if (lastEventId !== '') parts.push(`last id ${lastEventId}`);
  return parts.join(' · ');
}

/** The newest event row's last-event-id, read from the end: a live half holds thousands of rows. */
function liveLastEventId(live: RestLiveState): string {
  for (let at = live.rows.length - 1; at >= 0; at -= 1) {
    const row = live.rows[at]!;
    if (row.kind === 'event') return row.lastEventId;
  }
  return '';
}

/** The `200 OK · 12 ms · 1.2 KB · HTTP/1.1` line. */
export function StatusLine({ exchange, error, sending = false, live }: StatusLineProps) {
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
  if (exchange === undefined && live !== undefined) {
    // Not a live region: it changes with every event, and a screen reader would read each one.
    return (
      <p data-testid="rest-response-status" className="truncate px-2 font-mono text-xs text-fg-muted">
        {live.status !== undefined && (
          <span className={`font-medium ${statusToneClass(live.status)}`}>{live.status}</span>
        )}
        {live.status !== undefined && ' · '}
        {streamCountsText(live.counts.events, liveLastEventId(live))}
        {live.counts.bytes > 0 && ` · ${formatBytes(live.counts.bytes)}`}
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

  // A stream's end is not news worth interrupting for — it was on screen all along — unless it
  // failed; every other finished send is announced as it always was.
  const announce = exchange.stream === undefined || exchange.stream.endedBy === 'error';

  return (
    <p
      {...(announce ? { role: 'status' } : {})}
      data-testid="rest-response-status"
      className="truncate px-2 font-mono text-xs text-fg-muted"
    >
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
      {exchange.stream !== undefined &&
        ` · ${streamCountsText(exchange.stream.counts.events, exchange.stream.lastEventId)}`}
      {exchange.stream?.endedBy === 'client' && ' · stopped'}
      {exchange.stream?.endedBy === 'error' && (
        <span className="text-status-danger">{` · ended: ${exchange.stream.error ?? 'connection lost'}`}</span>
      )}
      {exchange.contract !== undefined && exchange.contract.status !== 'no-contract' && (
        <>
          {' · '}
          <ContractChip result={exchange.contract} />
        </>
      )}
    </p>
  );
}
