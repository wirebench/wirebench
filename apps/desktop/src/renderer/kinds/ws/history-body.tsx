import type { HistoryEntryWire } from '@shared/wire-types.js';
import { WsSummaryLine, WsTimelineWithDetail } from '../../features/ws-editor/response-pane.js';

/**
 * What a capped transcript left out: the frames dropped from the middle, and whether any kept
 * frame lost its payload to the byte budget. Worded from the record itself, not the cap's sizes.
 */
export function truncationNote(ws: NonNullable<HistoryEntryWire['ws']>): string {
  const omitted = ws.omittedFrames ?? 0;
  const parts: string[] = [];
  if (omitted > 0) {
    parts.push(`${String(omitted)} frame${omitted === 1 ? '' : 's'} from the middle of the session were not kept.`);
  }
  if (ws.frames.some((frame) => frame.payloadTruncated === true)) {
    parts.push('Some payloads were not kept either; their frames show their size.');
  }
  return parts.length === 0 ? 'Part of this session was not kept.' : parts.join(' ');
}

/**
 * A WebSocket session's record: the status line the editor shows and a read-only timeline. A
 * transcript the history cap trimmed says so, because the gap is in the middle of the session.
 */
export function WsHistoryBody({ entry }: { readonly entry: HistoryEntryWire }) {
  const { ws, durationMs } = entry;
  if (ws === undefined) return null;
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className="flex h-row shrink-0 items-center border-b border-hairline">
        <WsSummaryLine
          summary={{
            status: ws.status,
            protocol: ws.protocol,
            elapsedMs: durationMs,
            sent: ws.counts.sent,
            received: ws.counts.received,
            bytes: ws.counts.bytesSent + ws.counts.bytesReceived,
          }}
        />
      </div>
      {ws.error !== undefined && <p className="px-2 py-1 text-xs text-status-danger">{ws.error}</p>}
      {ws.truncated === true && (
        <p data-testid="ws-history-truncated" role="note" className="px-2 py-1 text-xs text-status-warning">
          {truncationNote(ws)}
        </p>
      )}
      <WsTimelineWithDetail frames={ws.frames} />
    </div>
  );
}
