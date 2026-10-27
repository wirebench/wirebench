import type { HistoryEntryWire } from '@shared/wire-types.js';
import { EventsView } from '../../features/rest-editor/response/events-view.js';
import { streamCountsText } from '../../features/rest-editor/response/status-line.js';

/**
 * What a capped event-stream record left out: the rows missing from the middle, and whether any kept
 * event lost its data to the byte budget. Worded from the record, not the cap's sizes — the byte
 * budget can cut differently from the row counts.
 */
export function sseTruncationNote(sse: NonNullable<HistoryEntryWire['sse']>): string {
  const omitted = sse.omittedRows ?? 0;
  const parts: string[] = [];
  if (omitted > 0) {
    parts.push(`${String(omitted)} event${omitted === 1 ? '' : 's'} from the middle of the stream were not kept.`);
  }
  if (sse.rows.some((row) => row.kind === 'event' && row.payloadTruncated === true)) {
    parts.push('Some payloads were not kept either; their events show their size.');
  }
  return parts.length === 0 ? 'Part of this stream was not kept.' : parts.join(' ');
}

/** An event-stream send's record: a summary line, how it ended, and the rows read-only. */
export function SseHistoryBody({ entry }: { readonly entry: HistoryEntryWire }) {
  const { sse, status } = entry;
  if (sse === undefined) return null;
  const parts: string[] = [];
  if (status !== undefined) parts.push(String(status));
  parts.push(streamCountsText(sse.counts.events, sse.lastEventId));
  if (sse.endedBy === 'client') parts.push('stopped');
  if (sse.endedBy === 'error') parts.push(`ended: ${sse.error ?? 'connection lost'}`);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-row shrink-0 items-center border-b border-hairline">
        <p data-testid="sse-history-status" className="truncate px-2 font-mono text-xs text-fg-muted">
          {parts.join(' · ')}
        </p>
      </div>
      {sse.error !== undefined && sse.endedBy !== 'error' && (
        <p className="px-2 py-1 text-xs text-status-danger">{sse.error}</p>
      )}
      {sse.truncated === true && (
        <p data-testid="sse-history-truncated" role="note" className="px-2 py-1 text-xs text-status-warning">
          {sseTruncationNote(sse)}
        </p>
      )}
      <EventsView rows={sse.rows} omittedRows={sse.omittedRows} readOnly />
    </div>
  );
}
