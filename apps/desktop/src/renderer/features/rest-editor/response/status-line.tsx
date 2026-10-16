/**
 * The response pane's header line: what came back, how long it took and how big it was.
 *
 * The status is coloured by class rather than by "did it work": a 404 is a perfectly good answer to
 * a request that asked for something absent, so it reads as a client error rather than as a failure
 * of the app. A transport failure has no status at all: the line names it in plain words, and the
 * panel under it says the rest.
 */
import { Fragment, useEffect, useState, type ReactNode } from 'react';
import type { IpcError } from '../../../../shared/ipc.js';
import type { RestExchangeSummary } from '../../../../shared/kinds/rest/wire.js';
import { base64ByteLength, formatBytes } from '../../../lib/format-size.js';
import type { RestLiveState } from '../../../state/exchanges.js';
import { describeSendError } from '../../request-editor/send-error.js';
import { failedAssertionCount } from '../../assertions/assertion-results.js';
import { ContractChip } from './contract-chip.js';
import { GraphqlChip } from './graphql-chip.js';

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
  /** When the send in flight started (ISO), for the elapsed time beside "Sending…". */
  readonly startedAt?: string | undefined;
}

/** How often the elapsed time ticks: a tenth of a second is what it shows. */
const TICK_MS = 100;

/** `2.4 s`: the time a send has been out, to the tenth of a second. */
export function elapsedText(ms: number): string {
  return `${(Math.max(0, ms) / 1000).toFixed(1)} s`;
}

/** "Sending…" and a live timer. Only the words are announced: a ticking number would be read out every tick. */
function SendingStatus({ startedAt }: { readonly startedAt: string | undefined }) {
  const start = startedAt === undefined ? Number.NaN : Date.parse(startedAt);
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (Number.isNaN(start)) return undefined;
    const timer = setInterval(() => {
      setNow(Date.now());
    }, TICK_MS);
    return () => {
      clearInterval(timer);
    };
  }, [start]);
  return (
    <p data-testid="rest-response-status" className="px-2 font-mono text-xs text-fg-muted">
      <span role="status">Sending…</span>
      {!Number.isNaN(start) && (
        <span data-testid="rest-response-elapsed" aria-hidden="true" className="tabular-nums">
          {` ${elapsedText(now - start)}`}
        </span>
      )}
    </p>
  );
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
export function StatusLine({ exchange, error, sending = false, live, startedAt }: StatusLineProps) {
  if (error !== undefined) {
    // The title alone: the panel below carries the message, the hint and the code.
    const view = describeSendError(error);
    return (
      <p
        role="status"
        data-testid="rest-response-status"
        className={`truncate px-2 text-xs font-medium ${view.tone === 'danger' ? 'text-status-danger' : 'text-fg-muted'}`}
        title={error.message}
      >
        {view.title}
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
    return <SendingStatus startedAt={startedAt} />;
  }
  if (exchange === undefined) {
    return null;
  }

  const bodyBytes = base64ByteLength(exchange.http.bodyBase64);
  const totalBytes = base64ByteLength(exchange.http.rawResponseBase64);

  // A stream's end is not news worth interrupting for — it was on screen all along — unless it
  // failed; every other finished send is announced as it always was.
  const announce = exchange.stream === undefined || exchange.stream.endedBy === 'error';
  const failedAssertions = failedAssertionCount(exchange.assertions);

  // Each part keeps its words together, and the line wraps between parts rather than cutting the
  // last one short: at the default split a 500's `· HTTP/1.1` used to end as `· HTT…` (#636).
  const parts: { readonly key: string; readonly node: ReactNode }[] = [
    {
      key: 'status',
      node: (
        <span className={`font-medium ${statusToneClass(exchange.http.status)}`}>
          {exchange.http.status} {exchange.http.statusText}
        </span>
      ),
    },
    { key: 'time', node: `${Math.round(exchange.durationMs)} ms` },
    { key: 'body', node: `${formatBytes(bodyBytes)} body` },
  ];
  if (totalBytes > 0) parts.push({ key: 'total', node: `${formatBytes(totalBytes)} total` });
  if (exchange.http.httpVersion !== undefined)
    parts.push({ key: 'version', node: `HTTP/${exchange.http.httpVersion}` });
  if (exchange.methodChanged) {
    parts.push({ key: 'redirected', node: <span className="text-status-warning">redirected as GET</span> });
  }
  if (exchange.http.truncated === true) {
    parts.push({ key: 'truncated', node: <span className="text-status-warning">truncated</span> });
  }
  if (failedAssertions > 0) {
    parts.push({
      key: 'assertions',
      node: (
        <span data-testid="rest-response-assertions-failed" className="text-status-danger">
          {`${String(failedAssertions)} assertion${failedAssertions === 1 ? '' : 's'} failed`}
        </span>
      ),
    });
  }
  if (exchange.stream !== undefined) {
    parts.push({ key: 'stream', node: streamCountsText(exchange.stream.counts.events, exchange.stream.lastEventId) });
  }
  if (exchange.stream?.endedBy === 'client') parts.push({ key: 'stopped', node: 'stopped' });
  if (exchange.stream?.endedBy === 'error') {
    parts.push({
      key: 'ended',
      node: <span className="text-status-danger">{`ended: ${exchange.stream.error ?? 'connection lost'}`}</span>,
    });
  }
  if (exchange.contract !== undefined && exchange.contract.status !== 'no-contract') {
    parts.push({ key: 'contract', node: <ContractChip result={exchange.contract} /> });
  }

  return (
    <p
      {...(announce ? { role: 'status' } : {})}
      data-testid="rest-response-status"
      className="px-2 py-0.5 font-mono text-xs text-fg-muted"
    >
      {parts.map((part, index) => (
        <Fragment key={part.key}>
          {index > 0 && ' '}
          <span className="whitespace-nowrap">
            {index > 0 && '· '}
            {part.node}
          </span>
        </Fragment>
      ))}
      {exchange.graphql !== undefined && <GraphqlChip check={exchange.graphql} />}
    </p>
  );
}
