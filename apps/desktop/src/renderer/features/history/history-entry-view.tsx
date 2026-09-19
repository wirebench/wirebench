import { Group, Panel, Separator } from 'react-resizable-panels';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';
import { CodeEditor } from '../../editor/code-editor.js';
import { MethodBadge } from '../rest-api/method-badge.js';
import { prettyPrintBody, sniffLanguage } from './history-format.js';
import { formatBytes, formatDuration } from '../../lib/format-size.js';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { useEditorsStore } from '../../state/editors.js';
import { useHistoryStore } from '../../state/history.js';
import { useProjectStore } from '../../state/project.js';
import { ipc } from '../../state/ipc-client.js';
import { WsSummaryLine, WsTimelineWithDetail } from '../ws-editor/response-pane.js';
import { wsTabId } from '../ws-editor/ws-actions.js';

export interface HistoryEntryViewProps {
  readonly historyId: string;
}

const SEPARATOR = 'bg-hairline transition-colors hover:bg-accent-muted focus-visible:bg-accent';

/**
 * A read-only "history" editor tab: one recorded send's request and response, plus Re-send and
 * (when the original request still exists) a "Go to request" link.
 *
 * Both bodies are shown in whatever they turn out to be, so a REST entry reads as the JSON it was
 * rather than as malformed XML. A REST entry's header carries its method; a SOAP entry's says SOAP.
 */
export function HistoryEntryView({ historyId }: HistoryEntryViewProps) {
  const entry = useHistoryStore((state) => state.entries.find((e) => e.id === historyId));
  const openTab = useEditorsStore((state) => state.open);
  const draftExists = useProjectStore((state) =>
    entry?.requestId !== undefined ? state.requests[entry.requestId] !== undefined : false,
  );
  const restRequestExists = useProjectStore((state) =>
    entry?.requestId !== undefined ? state.restRequests[entry.requestId] !== undefined : false,
  );
  const grpcRequestExists = useProjectStore((state) =>
    entry?.requestId !== undefined ? state.grpcRequests[entry.requestId] !== undefined : false,
  );
  const wsRequestExists = useProjectStore((state) =>
    entry?.requestId !== undefined ? state.wsRequests[entry.requestId] !== undefined : false,
  );

  if (entry === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This entry is no longer available.</p>;
  }

  const onResend = () => {
    void ipc()
      .history.resend({ id: entry.id })
      .then((result) => {
        if (!result.ok) {
          showToast(result.error.code);
        }
      });
  };

  const onGoToRequest = () => {
    if (entry.requestId === undefined) {
      return;
    }
    // Whichever protocol recorded the entry, the tab opened is that protocol's editor.
    openTab(
      entry.kind === 'rest'
        ? {
            id: `rest:${entry.requestId}`,
            kind: 'rest-request',
            title: entry.requestName,
            restRequestId: entry.requestId,
          }
        : entry.kind === 'websocket'
          ? {
              id: wsTabId(entry.requestId),
              kind: 'ws-request',
              title: entry.requestName,
              wsRequestId: entry.requestId,
            }
          : entry.kind === 'grpc'
            ? {
                id: `grpc:${entry.requestId}`,
                kind: 'grpc-request',
                title: entry.requestName,
                grpcRequestId: entry.requestId,
              }
            : {
                id: `request:${entry.requestId}`,
                kind: 'request',
                title: entry.requestName,
                requestId: entry.requestId,
              },
    );
  };

  const requestBody = entry.request.envelopeXml;
  const responseBody = entry.response?.envelopeXml ?? entry.error?.message ?? '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-3 py-2 text-sm">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium text-fg-default">
            {entry.kind === 'rest' && entry.method !== undefined ? (
              <MethodBadge method={entry.method} className="w-auto" />
            ) : entry.kind === 'grpc' ? (
              <span className="text-xs text-fg-faint">gRPC</span>
            ) : entry.kind === 'websocket' ? (
              <span className="text-xs text-fg-faint">WS</span>
            ) : (
              <span className="text-xs text-fg-faint">SOAP</span>
            )}
            {entry.requestName}
            {entry.operationName.length > 0 ? ` · ${entry.operationName}` : ''}
          </p>
          <p className="truncate text-xs text-fg-subtle" title={entry.endpoint}>
            {new Date(entry.at).toLocaleString()} · {entry.endpoint} · {formatDuration(entry.durationMs)} ·{' '}
            {formatBytes(entry.sizeBytes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {(draftExists || restRequestExists || grpcRequestExists || wsRequestExists) && (
            <Button variant="ghost" onClick={onGoToRequest}>
              Go to request
            </Button>
          )}
          {/* A session is not replayed from History; it reconnects from its request. */}
          {entry.kind !== 'websocket' && (
            <Button variant="secondary" onClick={onResend}>
              Re-send
            </Button>
          )}
        </div>
      </div>
      {entry.kind === 'websocket' && entry.ws !== undefined ? (
        <WsHistoryBody ws={entry.ws} durationMs={entry.durationMs} />
      ) : (
        <div className="min-h-0 flex-1">
          <Group orientation="horizontal" className="flex h-full">
            <Panel defaultSize={50} minSize={20}>
              <CodeEditor
                ariaLabel="History request body"
                language={sniffLanguage(requestBody)}
                value={prettyPrintBody(requestBody)}
                readOnly
              />
            </Panel>
            <Separator className={SEPARATOR} />
            <Panel defaultSize={50} minSize={20}>
              <CodeEditor
                ariaLabel="History response body"
                language={sniffLanguage(responseBody)}
                value={prettyPrintBody(responseBody)}
                readOnly
              />
            </Panel>
          </Group>
        </div>
      )}
    </div>
  );
}

/**
 * A WebSocket session's record: the status line the editor shows and a read-only timeline. A
 * transcript the history cap trimmed says so, because the gap is in the middle of the session.
 */
function WsHistoryBody({
  ws,
  durationMs,
}: {
  readonly ws: NonNullable<HistoryEntryWire['ws']>;
  readonly durationMs: number;
}) {
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
          {`The first 400 and last 100 frames were kept; ${String(ws.omittedFrames ?? 0)} omitted`}
        </p>
      )}
      <WsTimelineWithDetail frames={ws.frames} />
    </div>
  );
}
