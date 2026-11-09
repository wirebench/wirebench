/**
 * A REST tab's last recorded response, from History, while it has no send of its own: after a reload or a
 * relaunch the exchanges store starts empty, though History still holds the request's last send (#915).
 * Read-only, and marked as History's, so it never reads as a fresh answer; the next send replaces it.
 */
import type { HistoryEntryWire } from '@shared/wire-types.js';
import { CodeEditor } from '../../../editor/code-editor.js';
import { SseHistoryBody } from '../../../kinds/rest/history-body.js';
import { formatBytes, formatDuration } from '../../../lib/format-size.js';
import { useHistoryStore } from '../../../state/history.js';
import { prettyPrintBody, sniffLanguage } from '../../history/history-format.js';
import { statusToneClass } from './status-line.js';

/** The newest REST entry of `requestId` that recorded a response (History lists newest first). */
export function latestRecordedResponse(
  entries: readonly HistoryEntryWire[],
  requestId: string,
): HistoryEntryWire | undefined {
  return entries.find(
    (entry) =>
      entry.kind === 'rest' &&
      entry.requestId === requestId &&
      (entry.response !== undefined || entry.sse !== undefined),
  );
}

/** The recorded response, or the empty pane's line when History holds none for this request. */
export function LastRecordedResponse({ requestId }: { readonly requestId: string }) {
  const entry = useHistoryStore((state) => latestRecordedResponse(state.entries, requestId));
  if (entry === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">Send the request to see its response.</p>;
  }
  const { response } = entry;
  const body = response?.envelopeXml ?? '';
  return (
    <div data-testid="rest-response-recorded" className="flex min-h-0 flex-1 flex-col">
      <p
        role="note"
        data-testid="rest-response-recorded-note"
        className="shrink-0 border-b border-hairline px-3 py-1 text-xs text-fg-subtle"
      >
        Last response, from History · {new Date(entry.at).toLocaleString()}
      </p>
      {entry.sse !== undefined ? (
        <SseHistoryBody entry={entry} />
      ) : (
        <>
          <p className="shrink-0 truncate px-3 py-1 font-mono text-xs text-fg-subtle">
            {response !== undefined && (
              <>
                <span className={`font-medium ${statusToneClass(response.status)}`}>
                  {response.status} {response.statusText}
                </span>
                {' · '}
              </>
            )}
            {formatDuration(entry.durationMs)} · {formatBytes(entry.sizeBytes)}
          </p>
          <div className="min-h-0 flex-1">
            <CodeEditor
              ariaLabel="Recorded response body"
              language={sniffLanguage(body)}
              value={prettyPrintBody(body)}
              readOnly
            />
          </div>
        </>
      )}
    </div>
  );
}
