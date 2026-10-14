/**
 * The MCP response's status line (#79): how the server answered — `OK`, `Tool error (isError)`,
 * `Error -32602 Invalid params`, or why the session stopped — then the duration, the message count
 * and the warnings count. A stopped session also shows the tail of the server's stderr under it,
 * since that is usually where a crashed stdio server says why.
 *
 * Shared by the editor (which also has the in-flight and IPC-failure lines) and History, whose
 * record has the same fields under a different type: both read through {@link McpOutcomeRecord}.
 */
import type { McpExchangeSummary } from '../../../../shared/kinds/mcp/wire.js';
import type { McpExchangeState } from '../../../state/exchanges.js';
import { formatDuration } from '../../../lib/format-size.js';

/** The fields an outcome is read from; an exchange summary and a History record both have them. */
export type McpOutcomeRecord = Pick<McpExchangeSummary, 'result' | 'error' | 'failure' | 'warnings' | 'stderr'>;

export type McpOutcomeTone = 'success' | 'warning' | 'danger';

/** How many of stderr's last lines a stopped session shows. */
const STDERR_TAIL_LINES = 6;

/** Whether a result is a tool's own error: `isError: true` on a `tools/call` result. */
export function isToolError(result: unknown): boolean {
  return typeof result === 'object' && result !== null && (result as { isError?: unknown }).isError === true;
}

/** The outcome's words and how they read: a JSON-RPC error, a stopped session, a tool error, or OK. */
export function mcpRecordOutcome(record: McpOutcomeRecord): { readonly text: string; readonly tone: McpOutcomeTone } {
  if (record.error !== undefined) {
    return { text: `Error ${String(record.error.code)} ${record.error.message}`, tone: 'danger' };
  }
  if (record.failure !== undefined) {
    return { text: `${record.failure.code} · ${record.failure.message}`, tone: 'danger' };
  }
  if (isToolError(record.result)) return { text: 'Tool error (isError)', tone: 'warning' };
  return { text: 'OK', tone: 'success' };
}

/** The last few non-blank lines of stderr; empty when there is none. */
export function stderrTail(stderr: string | undefined, lines = STDERR_TAIL_LINES): string {
  if (stderr === undefined) return '';
  const kept = stderr.split(/\r?\n/).filter((line) => line.trim() !== '');
  return kept.slice(-lines).join('\n');
}

const plural = (count: number, word: string): string => `${String(count)} ${word}${count === 1 ? '' : 's'}`;

const TONE_CLASS: Record<McpOutcomeTone, string> = {
  success: 'text-status-success',
  warning: 'text-status-warning',
  danger: 'text-status-danger',
};

export interface McpSummaryLineProps {
  readonly record: McpOutcomeRecord;
  readonly durationMs: number;
  readonly messageCount: number;
}

/** The line for a finished session, from its record alone: History has no live state to read. */
export function McpSummaryLine({ record, durationMs, messageCount }: McpSummaryLineProps) {
  const outcome = mcpRecordOutcome(record);
  const tail = record.failure === undefined ? '' : stderrTail(record.stderr);
  const warnings = record.warnings.length;
  return (
    <div className="flex min-w-0 flex-col">
      <p data-testid="mcp-response-status" className="flex min-w-0 items-center gap-2 px-2 font-mono text-xs">
        <span data-testid="mcp-response-outcome" className={`truncate font-medium ${TONE_CLASS[outcome.tone]}`}>
          {outcome.text}
        </span>
        <span className="shrink-0 text-fg-subtle">{formatDuration(durationMs)}</span>
        <span className="shrink-0 text-fg-subtle">{plural(messageCount, 'message')}</span>
        {warnings > 0 && (
          <span data-testid="mcp-response-warnings-count" className="shrink-0 text-status-warning">
            {plural(warnings, 'warning')}
          </span>
        )}
      </p>
      {tail !== '' && (
        <pre
          data-testid="mcp-response-stderr-tail"
          className="mx-2 mb-1 max-h-24 overflow-auto font-mono text-xs whitespace-pre-wrap text-fg-muted select-text"
        >
          {tail}
        </pre>
      )}
    </div>
  );
}

/** The editor's line: in flight, failed before an exchange, or the finished session's summary. */
export function McpStatusLine({ state }: { readonly state: McpExchangeState | undefined }) {
  if (state === undefined) return null;
  if (state.status === 'sending') {
    const count = state.live?.messages.length ?? 0;
    return (
      <p role="status" data-testid="mcp-response-status" className="px-2 font-mono text-xs text-fg-muted">
        {`Sending… · ${plural(count, 'message')}`}
      </p>
    );
  }
  const exchange = state.exchange;
  if (state.status === 'error' || exchange === undefined) {
    if (state.error === undefined && state.status !== 'error') return null;
    return (
      <p role="status" data-testid="mcp-response-status" className="truncate px-2 font-mono text-xs text-status-danger">
        {state.error === undefined ? 'The send failed.' : `${state.error.code} · ${state.error.message}`}
      </p>
    );
  }
  return <McpSummaryLine record={exchange} durationMs={exchange.durationMs} messageCount={exchange.messages.length} />;
}
