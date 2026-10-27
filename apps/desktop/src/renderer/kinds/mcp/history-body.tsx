/**
 * An MCP send's History record, read-only (#79): how the session went, the operation's result and
 * every JSON-RPC message kept, in order. The result and the messages are the editor's own response
 * views, fed from the record.
 */
import { McpWarnings } from '../../features/mcp-editor/response/response-pane.js';
import { McpMessagesView } from '../../features/mcp-editor/response/messages-view.js';
import { McpResultView } from '../../features/mcp-editor/response/result-view.js';
import { mcpRecordOutcome } from '../../features/mcp-editor/response/status-line.js';
import type { HistoryEntryWire } from '@shared/wire-types.js';

type HistoryMcp = NonNullable<HistoryEntryWire['mcp']>;

/** The status line's words: how the server answered, or why the session did not finish. */
export function mcpOutcome(mcp: HistoryMcp): string {
  if (mcp.failure !== undefined) return mcp.failure.message;
  return mcpRecordOutcome(mcp).text;
}

/** What History's cap left out, worded from the record itself. */
export function mcpTruncationNote(mcp: HistoryMcp): string {
  const omitted = mcp.omittedMessages ?? 0;
  const parts: string[] = [];
  if (omitted > 0) {
    parts.push(`${String(omitted)} message${omitted === 1 ? '' : 's'} from the middle of the session were not kept.`);
  }
  if (mcp.messages.some((message) => message.payloadTruncated === true)) {
    parts.push('Some messages’ text was not kept either; they show their size.');
  }
  return parts.length === 0 ? 'Part of this session was not kept.' : parts.join(' ');
}

export function McpHistoryBody({ entry }: { readonly entry: HistoryEntryWire }) {
  const { mcp, durationMs } = entry;
  if (mcp === undefined) return null;
  const outcome = mcpOutcome(mcp);
  const failed = outcome !== 'OK';
  return (
    <div data-testid="mcp-history-body" className="flex min-h-0 flex-1 flex-col overflow-auto">
      <div className="flex h-row shrink-0 items-center gap-3 border-b border-hairline px-2 text-xs">
        <span data-testid="mcp-history-outcome" className={failed ? 'text-status-danger' : 'text-status-success'}>
          {outcome}
        </span>
        <span className="font-mono text-fg-muted">{mcp.method}</span>
        <span className="text-fg-subtle">{String(Math.round(durationMs))} ms</span>
        <span className="text-fg-subtle">
          {String(mcp.messages.length)} message{mcp.messages.length === 1 ? '' : 's'}
        </span>
        {mcp.serverInfo !== undefined && (
          <span className="text-fg-subtle">
            {mcp.serverInfo.name} {mcp.serverInfo.version}
          </span>
        )}
      </div>
      {mcp.truncated === true && (
        <p data-testid="mcp-history-truncated" role="note" className="px-2 py-1 text-xs text-status-warning">
          {mcpTruncationNote(mcp)}
        </p>
      )}
      <McpWarnings warnings={mcp.warnings} />
      <section data-testid="mcp-history-result" className="flex flex-col border-b border-hairline">
        <h3 className="px-2 pt-2 text-xs font-medium text-fg-subtle">Result</h3>
        <McpResultView
          method={mcp.method}
          result={mcp.result}
          error={mcp.error}
          resultOmitted={mcp.resultOmitted === true}
        />
      </section>
      <section data-testid="mcp-history-messages" className="flex min-h-64 flex-col">
        <h3 className="px-2 pt-2 text-xs font-medium text-fg-subtle">Messages</h3>
        <McpMessagesView
          messages={mcp.messages}
          startedAt={mcp.startedAt}
          transport={mcp.transport.type}
          droppedMessages={mcp.droppedMessages}
          httpCalls={mcp.httpCalls}
          stderr={mcp.stderr}
          stderrTruncated={mcp.stderrTruncated}
          exitCode={mcp.exitCode}
          exitSignal={mcp.exitSignal}
        />
      </section>
    </div>
  );
}
