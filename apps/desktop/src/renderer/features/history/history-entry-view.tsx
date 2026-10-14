import { Suspense } from 'react';
import { Group, Panel, Separator } from 'react-resizable-panels';
import { rendererKindOf } from '../../kinds/index.js';
import { CodeEditor } from '../../editor/code-editor.js';
import { prettyPrintBody, sniffLanguage } from './history-format.js';
import { formatBytes, formatDuration } from '../../lib/format-size.js';
import { Button } from '../../components/button.js';
import { useHistoryStore } from '../../state/history.js';
import { canResendHistoryEntry, resendHistoryEntry } from './history-actions.js';
import { useProjectStore } from '../../state/project.js';

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
  const kind = rendererKindOf(entry?.kind);
  const requestExists = useProjectStore((state) =>
    entry?.requestId !== undefined && kind !== undefined ? kind.requests.exists(entry.requestId, state) : false,
  );

  if (entry === undefined || kind === undefined) {
    return <p className="p-4 text-sm text-fg-subtle">This entry is no longer available.</p>;
  }

  const onResend = () => {
    void resendHistoryEntry(entry);
  };

  const onGoToRequest = () => {
    // Whichever protocol recorded the entry, the tab opened is that protocol's editor.
    if (entry.requestId !== undefined) kind.requests.open(entry.requestId, entry.requestName);
  };

  const requestBody = entry.request.envelopeXml;
  const responseBody = entry.response?.envelopeXml ?? entry.error?.message ?? '';

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-3 border-b border-hairline px-3 py-2 text-sm">
        <div className="min-w-0">
          <p className="flex items-center gap-1.5 truncate font-medium text-fg-default">
            <kind.history.Badge entry={entry} place="header" />
            {entry.requestName}
            {entry.operationName.length > 0 ? ` · ${entry.operationName}` : ''}
            {kind.history.Chip !== undefined && <kind.history.Chip entry={entry} />}
          </p>
          <p className="truncate text-xs text-fg-subtle" title={entry.endpoint}>
            {new Date(entry.at).toLocaleString()} · {entry.endpoint} · {formatDuration(entry.durationMs)} ·{' '}
            {formatBytes(entry.sizeBytes)}
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          {requestExists && (
            <Button variant="ghost" onClick={onGoToRequest}>
              Go to request
            </Button>
          )}
          {/* SOAP, gRPC and REST sends replay from History; a WebSocket session and a REST event
              stream resend from their request. */}
          {canResendHistoryEntry(entry) && (
            <Button variant="secondary" onClick={onResend}>
              Re-send
            </Button>
          )}
        </div>
      </div>
      {kind.history.Body !== undefined && kind.history.hasBody?.(entry) === true ? (
        <Suspense fallback={<p className="p-4 text-sm text-fg-subtle">Loading…</p>}>
          <kind.history.Body entry={entry} />
        </Suspense>
      ) : requestBody.trim().length === 0 ? (
        // A GET (or any send with no body) has nothing to show on the request side: the response
        // takes the whole tab rather than sitting beside an empty editor.
        <div className="flex min-h-0 flex-1 flex-col">
          <p data-testid="history-no-request-body" className="shrink-0 px-3 py-1 text-xs text-fg-faint">
            The request had no body.
          </p>
          <div className="min-h-0 flex-1">
            <CodeEditor
              ariaLabel="History response body"
              language={sniffLanguage(responseBody)}
              value={prettyPrintBody(responseBody)}
              readOnly
            />
          </div>
        </div>
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
