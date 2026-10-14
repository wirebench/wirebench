/**
 * The session's JSON-RPC messages, both ways, in the order they happened (#79), with the selected
 * message's JSON under the list. Beside them is what carried the messages: the HTTP calls for the
 * Streamable HTTP and SSE transports, or the server's stderr and exit for stdio.
 *
 * A session is a handful of messages (initialize, initialized, the operation, its answer), so unlike
 * the WebSocket timeline this paints every row and needs no window.
 */
import { useState, type KeyboardEvent } from 'react';
import { ArrowDown, ArrowUp, TriangleAlert } from 'lucide-react';
import { formatBytes, formatDuration } from '../../../lib/format-size.js';
import type { McpHttpCallWire, McpMessageWire } from '../../../../shared/kinds/mcp/wire.js';

/** A message's time since the session started: `+12 ms`; `—` when either time does not parse. */
export function messageOffset(startedAt: string, at: string): string {
  const offset = Date.parse(at) - Date.parse(startedAt);
  return Number.isNaN(offset) ? '—' : `+${String(Math.max(0, Math.round(offset)))} ms`;
}

/** What a row names a message by: its method, else its id with its kind (`#2 result`). */
export function messageLabel(message: McpMessageWire): string {
  if (message.method !== undefined) return message.method;
  if (message.id !== undefined) return `#${String(message.id)} ${message.kind}`;
  return message.kind;
}

/** A message's text pretty-printed, or as it came when it is not JSON. */
function pretty(text: string): string {
  try {
    return JSON.stringify(JSON.parse(text), null, 2);
  } catch {
    return text;
  }
}

function MessageRow({
  message,
  index,
  startedAt,
  selected,
  onSelect,
}: {
  readonly message: McpMessageWire;
  readonly index: number;
  readonly startedAt: string;
  readonly selected: boolean;
  readonly onSelect: (index: number) => void;
}) {
  const sent = message.direction === 'sent';
  const warnings = message.warnings.length;
  return (
    <li
      role="option"
      aria-selected={selected}
      data-testid="mcp-message-row"
      onClick={() => {
        onSelect(index);
      }}
      className={`flex h-6 cursor-default items-center gap-2 px-2 ${
        selected ? 'bg-accent-muted text-fg-default' : 'text-fg-muted hover:bg-surface-raised'
      }`}
    >
      <span
        role="img"
        aria-label={sent ? 'Sent' : 'Received'}
        className={`shrink-0 ${sent ? 'text-status-info' : 'text-status-success'}`}
      >
        {sent ? <ArrowUp size={12} aria-hidden="true" /> : <ArrowDown size={12} aria-hidden="true" />}
      </span>
      <span className="w-16 shrink-0 text-fg-subtle">{messageOffset(startedAt, message.at)}</span>
      <span
        className={`min-w-0 flex-1 truncate ${message.kind === 'error' || message.kind === 'invalid' ? 'text-status-danger' : 'text-fg-default'}`}
      >
        {messageLabel(message)}
      </span>
      {warnings > 0 && (
        <span
          data-testid="mcp-message-warnings"
          title={message.warnings.join('\n')}
          className="flex shrink-0 items-center gap-0.5 text-status-warning"
        >
          <TriangleAlert size={12} aria-hidden="true" />
          {String(warnings)}
        </span>
      )}
      <span className="w-16 shrink-0 text-right text-fg-subtle">{formatBytes(message.size)}</span>
    </li>
  );
}

/** One message's JSON, its warnings, or a note that its text was not kept. */
function MessageDetail({ message }: { readonly message: McpMessageWire }) {
  return (
    <div data-testid="mcp-message-detail" className="flex min-h-0 flex-1 flex-col border-t border-hairline">
      <p className="shrink-0 px-2 py-1 font-mono text-xs text-fg-subtle">
        {`${message.direction} · ${message.kind} · ${formatBytes(message.size)}`}
      </p>
      {message.warnings.map((warning) => (
        <p key={warning} className="px-2 text-xs text-status-warning">
          {warning}
        </p>
      ))}
      {message.text === '' || message.payloadTruncated === true ? (
        <p className="p-2 text-sm text-fg-subtle">This message’s text was not kept. Its size is.</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs whitespace-pre-wrap text-fg-default select-text">
          {pretty(message.text)}
        </pre>
      )}
    </div>
  );
}

function HttpCalls({ calls }: { readonly calls: readonly McpHttpCallWire[] }) {
  if (calls.length === 0) return <p className="p-2 text-sm text-fg-subtle">No HTTP calls.</p>;
  return (
    <table aria-label="HTTP calls" data-testid="mcp-http-calls" className="w-full border-collapse font-mono text-xs">
      <thead>
        <tr className="border-b border-hairline text-left text-fg-subtle">
          <th scope="col" className="px-2 py-1 font-medium">
            Method
          </th>
          <th scope="col" className="px-2 py-1 font-medium">
            URL
          </th>
          <th scope="col" className="px-2 py-1 font-medium">
            Status
          </th>
          <th scope="col" className="px-2 py-1 text-right font-medium">
            Time
          </th>
        </tr>
      </thead>
      <tbody>
        {calls.map((call, index) => (
          <tr key={`${call.startedAt}-${String(index)}`} data-testid="mcp-http-call" className="align-top">
            <td className="px-2 py-0.5 text-fg-default">{call.method}</td>
            <td className="px-2 py-0.5 break-all text-fg-default">
              {call.url}
              {call.error !== undefined && <span className="block text-status-danger">{call.error}</span>}
            </td>
            <td className={`px-2 py-0.5 ${call.status >= 400 || call.status === 0 ? 'text-status-danger' : ''}`}>
              {call.status === 0 ? '—' : String(call.status)}
            </td>
            <td className="px-2 py-0.5 text-right text-fg-subtle">
              {call.timings === undefined ? '—' : formatDuration(call.timings.totalMs)}
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

function Stderr({
  stderr,
  truncated,
  exitCode,
  exitSignal,
}: {
  readonly stderr: string | undefined;
  readonly truncated: boolean | undefined;
  readonly exitCode: number | null | undefined;
  readonly exitSignal: string | null | undefined;
}) {
  const exit =
    exitSignal !== undefined && exitSignal !== null
      ? `Exited on ${exitSignal}`
      : exitCode !== undefined && exitCode !== null
        ? `Exit code ${String(exitCode)}`
        : undefined;
  return (
    <div data-testid="mcp-stderr" className="flex min-h-0 flex-1 flex-col">
      {exit !== undefined && <p className="px-2 py-1 font-mono text-xs text-fg-muted">{exit}</p>}
      {stderr === undefined || stderr === '' ? (
        <p className="p-2 text-sm text-fg-subtle">The server wrote nothing to stderr.</p>
      ) : (
        <pre className="min-h-0 flex-1 overflow-auto px-2 py-1 font-mono text-xs whitespace-pre-wrap text-fg-muted select-text">
          {stderr}
        </pre>
      )}
      {truncated === true && <p className="px-2 py-1 text-xs text-fg-subtle">Only the end of stderr was kept.</p>}
    </div>
  );
}

export interface McpMessagesViewProps {
  readonly messages: readonly McpMessageWire[];
  readonly startedAt: string;
  readonly transport: 'stdio' | 'http' | 'sse';
  /** Messages past the session's own cap, not kept. */
  readonly droppedMessages?: number | undefined;
  readonly httpCalls?: readonly McpHttpCallWire[] | undefined;
  readonly stderr?: string | undefined;
  readonly stderrTruncated?: boolean | undefined;
  readonly exitCode?: number | null | undefined;
  readonly exitSignal?: string | null | undefined;
}

/** The messages, the selected one's JSON, and the transport's side panel. */
export function McpMessagesView(props: McpMessagesViewProps) {
  const { messages, startedAt, transport, droppedMessages } = props;
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const message = selected === undefined ? undefined : messages[selected];

  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (messages.length === 0) return;
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0) return;
    event.preventDefault();
    const from = selected ?? (step > 0 ? -1 : messages.length);
    setSelected(Math.min(messages.length - 1, Math.max(0, from + step)));
  };

  return (
    <div data-testid="mcp-messages" className="flex min-h-0 flex-1">
      <div className="flex min-h-0 min-w-0 flex-[3] flex-col">
        <div className={`flex min-h-0 flex-col overflow-auto ${message === undefined ? 'flex-1' : 'basis-1/2'}`}>
          {droppedMessages !== undefined && droppedMessages > 0 && (
            <p className="px-2 py-1 text-xs text-fg-subtle">
              {`${String(droppedMessages)} more message${droppedMessages === 1 ? ' was' : 's were'} not kept.`}
            </p>
          )}
          {messages.length === 0 ? (
            <p className="p-2 text-sm text-fg-subtle">No messages yet.</p>
          ) : (
            <ul
              role="listbox"
              aria-label="Messages"
              tabIndex={0}
              onKeyDown={move}
              className="font-mono text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {messages.map((entry, index) => (
                <MessageRow
                  key={`${entry.at}-${String(index)}`}
                  message={entry}
                  index={index}
                  startedAt={startedAt}
                  selected={index === selected}
                  onSelect={setSelected}
                />
              ))}
            </ul>
          )}
        </div>
        {message !== undefined && (
          <div className="flex min-h-0 basis-1/2 flex-col">
            <MessageDetail message={message} />
          </div>
        )}
      </div>
      <aside
        aria-label={transport === 'stdio' ? 'stderr' : 'HTTP calls'}
        className="flex min-h-0 min-w-0 flex-[2] flex-col overflow-auto border-l border-hairline"
      >
        <h4 className="shrink-0 px-2 py-1 text-xs tracking-wider text-fg-subtle uppercase">
          {transport === 'stdio' ? 'stderr' : 'HTTP calls'}
        </h4>
        {transport === 'stdio' ? (
          <Stderr
            stderr={props.stderr}
            truncated={props.stderrTruncated}
            exitCode={props.exitCode}
            exitSignal={props.exitSignal}
          />
        ) : (
          <HttpCalls calls={props.httpCalls ?? []} />
        )}
      </aside>
    </div>
  );
}
