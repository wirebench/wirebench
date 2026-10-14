/**
 * An MCP send's History record, read-only (#79): how the session went, the operation's result and
 * every JSON-RPC message kept, in order. A plain view; the editor's response pane draws the same
 * record richly once it exists.
 */
import type { HistoryEntryWire } from '../../../shared/wire-types.js';

type HistoryMcp = NonNullable<HistoryEntryWire['mcp']>;

/** The status line's words: how the server answered, or why the session did not finish. */
export function mcpOutcome(mcp: HistoryMcp): string {
  if (mcp.failure !== undefined) return mcp.failure.message;
  if (mcp.error !== undefined) return `Error ${String(mcp.error.code)} ${mcp.error.message}`;
  const result = mcp.result as { readonly isError?: unknown } | undefined;
  if (result?.isError === true) return 'Tool error (isError)';
  return 'OK';
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

/** A message's JSON pretty-printed, or as it came when it is not JSON. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
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
      {mcp.warnings.map((warning) => (
        <p key={warning} className="px-2 py-1 text-xs text-status-warning">
          {warning}
        </p>
      ))}
      <section className="border-b border-hairline px-2 py-2">
        <h3 className="text-xs font-medium text-fg-subtle">Result</h3>
        {mcp.result !== undefined ? (
          <pre data-testid="mcp-history-result" className="mt-1 font-mono text-xs whitespace-pre-wrap text-fg-default">
            {JSON.stringify(mcp.result, null, 2)}
          </pre>
        ) : (
          <p className="mt-1 text-xs text-fg-subtle">
            {mcp.resultOmitted === true ? 'Too large to keep here; its message may still hold it.' : 'No result.'}
          </p>
        )}
      </section>
      <section className="px-2 py-2">
        <h3 className="text-xs font-medium text-fg-subtle">Messages</h3>
        <ol data-testid="mcp-history-messages" className="mt-1 flex flex-col gap-2">
          {mcp.messages.map((message, index) => (
            <li key={`${message.at}-${String(index)}`} className="text-xs">
              <div className="flex gap-2 text-fg-subtle">
                <span>{message.direction === 'sent' ? '↑' : '↓'}</span>
                <span className="font-mono text-fg-muted">{message.method ?? message.kind}</span>
                <span>{String(message.size)} B</span>
              </div>
              {message.text !== '' && (
                <pre className="mt-0.5 font-mono whitespace-pre-wrap text-fg-default">{pretty(message.text)}</pre>
              )}
            </li>
          ))}
        </ol>
      </section>
      {mcp.stderr !== undefined && mcp.stderr !== '' && (
        <section className="border-t border-hairline px-2 py-2">
          <h3 className="text-xs font-medium text-fg-subtle">stderr</h3>
          <pre className="mt-1 font-mono text-xs whitespace-pre-wrap text-fg-muted">{mcp.stderr}</pre>
        </section>
      )}
    </div>
  );
}
