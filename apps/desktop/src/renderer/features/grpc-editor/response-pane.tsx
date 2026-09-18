/**
 * The gRPC response half: the status line, then one of the response tabs.
 *
 * A gRPC call's outcome is its **status**, not its HTTP code — every call that reaches the server
 * comes back as HTTP 200, and `OK`, `NOT_FOUND` and `INTERNAL` all ride in the trailers — so the
 * line leads with the status name and code, and colours by whether it is `OK`. The messages the
 * server streamed back are listed one by one with their index, since a server-streaming call may
 * produce dozens and the order is part of the answer. Metadata shows the initial headers and the
 * trailers apart, because the two arrive at different moments and a status only ever lives in the
 * second. Timing, TLS and Raw are the shared surfaces the other protocols' panes use.
 */
import { useEffect, useRef, useState } from 'react';
import { Copy, Send, SquareDashedBottom } from 'lucide-react';
import { Button } from '../../components/button.js';
import { Tabs } from '../../components/tabs.js';
import type { IpcError } from '../../../shared/ipc.js';
import type { GrpcExchangeSummary, GrpcResponseMessageWire } from '../../../shared/wire-types.js';
import { base64ByteLength, formatBytes } from '../../lib/format-size.js';
import type { GrpcExchangeState, GrpcLiveState } from '../../state/exchanges.js';
import { InspectorIconButton } from '../request-editor/inspectors/inspector-strip.js';
import { SslInspector } from '../request-editor/inspectors/ssl-inspector.js';
import { TimingsBar } from '../console/timings-bar.js';

/** The response tabs, in order. */
const TABS = [
  { id: 'messages', label: 'Messages' },
  { id: 'metadata', label: 'Metadata' },
  { id: 'timing', label: 'Timing' },
  { id: 'tls', label: 'TLS' },
  { id: 'raw', label: 'Raw' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** The colour class for a gRPC status: `OK` is success, a locally enforced deadline is a warning, the rest failed. */
export function grpcStatusToneClass(exchange: Pick<GrpcExchangeSummary, 'status' | 'statusSource'>): string {
  if (exchange.status === 0) return 'text-status-success';
  if (exchange.statusSource === 'local') return 'text-status-warning';
  return 'text-status-danger';
}

/** How the status source reads on the line: where the status was found. */
const SOURCE_LABEL: Readonly<Record<GrpcExchangeSummary['statusSource'], string | undefined>> = {
  trailers: undefined,
  headers: 'trailers-only',
  http: 'from the HTTP status',
  local: 'deadline enforced locally',
};

export interface GrpcStatusLineProps {
  readonly exchange?: GrpcExchangeSummary | undefined;
  readonly error?: IpcError | undefined;
  readonly sending?: boolean;
  /** What has arrived so far, while the call is still running. */
  readonly live?: GrpcLiveState | undefined;
}

/** The `OK (0) · 12 ms · 3 messages · 1.2 KB` line. */
export function GrpcStatusLine({ exchange, error, sending = false, live }: GrpcStatusLineProps) {
  if (error !== undefined) {
    return (
      <p
        role="status"
        data-testid="grpc-response-status"
        className="truncate px-2 font-mono text-xs text-status-danger"
        title={error.message}
      >
        <span className="font-medium">{error.code}</span> · {error.message}
      </p>
    );
  }
  if (sending) {
    return (
      <p role="status" data-testid="grpc-response-status" className="px-2 font-mono text-xs text-fg-muted">
        {live === undefined || live.messages.length === 0
          ? 'Sending…'
          : `Streaming… · ${live.messages.length} message${live.messages.length === 1 ? '' : 's'}`}
        {live?.open === true && <span className="text-fg-subtle">{' · request side open'}</span>}
      </p>
    );
  }
  if (exchange === undefined) {
    return null;
  }
  const bytes = exchange.responseMessages.reduce((sum, message) => sum + message.bytes, 0);
  const count = exchange.responseMessages.length;
  const source = SOURCE_LABEL[exchange.statusSource];
  return (
    <p
      role="status"
      data-testid="grpc-response-status"
      className="truncate px-2 font-mono text-xs text-fg-muted"
      {...(exchange.statusMessage !== undefined ? { title: exchange.statusMessage } : {})}
    >
      <span className={`font-medium ${grpcStatusToneClass(exchange)}`}>
        {exchange.statusName} ({exchange.status})
      </span>
      {exchange.statusMessage !== undefined && exchange.statusMessage !== '' && ` · ${exchange.statusMessage}`}
      {' · '}
      {Math.round(exchange.durationMs)} ms{' · '}
      {count} message{count === 1 ? '' : 's'}
      {bytes > 0 && ` · ${formatBytes(bytes)}`}
      {exchange.encoding !== undefined && ` · ${exchange.encoding}`}
      {source !== undefined && <span className="text-fg-subtle">{` · ${source}`}</span>}
      {exchange.truncated && <span className="text-status-warning">{' · truncated'}</span>}
    </p>
  );
}

export interface GrpcResponsePaneProps {
  readonly state: GrpcExchangeState | undefined;
  /** Writes one more message on an open interactive call. Absent where the pane is read-only. */
  readonly onPush?: ((messageText: string) => void) | undefined;
  /** Half-closes an open interactive call's request side. */
  readonly onHalfClose?: (() => void) | undefined;
}

/** The response pane. */
export function GrpcResponsePane({ state, onPush, onHalfClose }: GrpcResponsePaneProps) {
  const [tab, setTab] = useState<TabId>('messages');
  const exchange = state?.exchange;
  const sending = state?.status === 'sending';
  const live = state?.live;
  // While the call runs the pane shows what has arrived; once it ends the exchange replaces it,
  // holding the same messages decoded the same way.
  const messages = exchange?.responseMessages ?? live?.messages ?? [];
  const headers = exchange?.headers ?? live?.headers;
  const showTabs = exchange !== undefined || live !== undefined;

  const items = TABS.map((item) =>
    item.id === 'messages' && messages.length > 0 ? { ...item, badge: String(messages.length) } : item,
  );

  return (
    <section aria-label="Response" data-testid="grpc-response" className="flex h-full min-h-0 flex-col">
      <div className="flex h-row shrink-0 items-center gap-2 border-b border-hairline">
        <div className="min-w-0 flex-1">
          <GrpcStatusLine
            {...(exchange !== undefined ? { exchange } : {})}
            {...(state?.error !== undefined ? { error: state.error } : {})}
            sending={sending}
            {...(live !== undefined ? { live } : {})}
          />
        </div>
      </div>

      {!showTabs ? (
        <p className="p-3 text-sm text-fg-subtle">{sending ? 'Sending…' : 'Send the request to see its response.'}</p>
      ) : (
        <>
          <Tabs label="Response tabs" items={items} active={tab} onSelect={setTab} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === 'messages' && (
              <MessagesView
                messages={messages}
                streaming={sending}
                {...(exchange !== undefined ? { status: exchange.status } : {})}
              />
            )}
            {tab === 'metadata' &&
              (exchange !== undefined ? (
                <MetadataView exchange={exchange} />
              ) : (
                <div data-testid="grpc-response-metadata" className="flex flex-col gap-3 overflow-auto p-2">
                  <MetadataTable
                    title="Headers"
                    testId="grpc-response-header-row"
                    entries={Object.entries(headers ?? {})}
                  />
                  <p className="text-sm text-fg-subtle">The trailers arrive when the call ends.</p>
                </div>
              ))}
            {tab === 'timing' &&
              (exchange === undefined ? (
                <p className="p-3 text-sm text-fg-subtle">Timing is measured when the call ends.</p>
              ) : (
                <div data-testid="grpc-response-timing" className="overflow-auto">
                  <TimingsBar timings={exchange.http.timings} />
                </div>
              ))}
            {tab === 'tls' &&
              (exchange === undefined ? (
                <p className="p-3 text-sm text-fg-subtle">The TLS details are read when the call ends.</p>
              ) : (
                <div data-testid="grpc-response-tls" className="overflow-auto">
                  <SslInspector http={exchange.http} />
                </div>
              ))}
            {tab === 'raw' &&
              (exchange === undefined ? (
                <p className="p-3 text-sm text-fg-subtle">The raw exchange is assembled when the call ends.</p>
              ) : (
                <RawExchange exchange={exchange} />
              ))}
          </div>
          {live?.open === true && onPush !== undefined && onHalfClose !== undefined && (
            <StreamComposer sent={live.sent} onPush={onPush} onHalfClose={onHalfClose} />
          )}
        </>
      )}
    </section>
  );
}

/**
 * The composer for a call whose request side is open: one more message, or a half-close.
 *
 * A plain textarea rather than the Monaco editor the request's Message tab uses — this is a line
 * of a conversation, typed and sent, not a document kept between calls.
 */
function StreamComposer({
  sent,
  onPush,
  onHalfClose,
}: {
  readonly sent: readonly string[];
  readonly onPush: (messageText: string) => void;
  readonly onHalfClose: () => void;
}) {
  const [text, setText] = useState('{}');
  const push = (): void => {
    if (text.trim() === '') return;
    onPush(text);
  };
  return (
    <div data-testid="grpc-stream-composer" className="shrink-0 border-t border-hairline p-2">
      <div className="mb-1 flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-fg-subtle uppercase">
          Send another message{sent.length > 0 && ` · ${sent.length} sent`}
        </h3>
        <Button variant="secondary" data-testid="grpc-half-close" onClick={onHalfClose} title="Stop sending messages">
          <SquareDashedBottom size={12} aria-hidden="true" />
          Half-close
        </Button>
      </div>
      <div className="flex items-start gap-2">
        <textarea
          aria-label="Message to send"
          data-testid="grpc-stream-message"
          spellCheck={false}
          rows={3}
          value={text}
          onChange={(event) => {
            setText(event.target.value);
          }}
          onKeyDown={(event) => {
            // Enter sends, as it would in any composer; a newline needs Shift.
            if (event.key === 'Enter' && !event.shiftKey && (event.metaKey || event.ctrlKey)) {
              event.preventDefault();
              push();
            }
          }}
          className="min-h-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised p-2 font-mono text-xs text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        />
        <Button variant="primary" data-testid="grpc-stream-send" onClick={push}>
          <Send size={12} aria-hidden="true" />
          Send
        </Button>
      </div>
    </div>
  );
}

/**
 * The decoded response messages, in order, each with its size; one that did not decode says why.
 *
 * Keyed by arrival index *and* content while a call streams, so React reuses the rows it already
 * painted instead of rebuilding the list on each message. The scroll follows the newest message
 * only while the reader is already at the bottom — scrolling up to read one pins the view there.
 */
function MessagesView({
  messages,
  streaming = false,
  status,
}: {
  readonly messages: readonly GrpcResponseMessageWire[];
  readonly streaming?: boolean;
  readonly status?: number;
}) {
  const all = messages.map((message) => message.json ?? '').join('\n');
  const scroller = useRef<HTMLDivElement | null>(null);
  const pinned = useRef(true);

  useEffect(() => {
    const element = scroller.current;
    if (element === null || !pinned.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [messages.length]);

  return (
    <div
      ref={scroller}
      data-testid="grpc-response-messages"
      onScroll={(event) => {
        const element = event.currentTarget;
        pinned.current = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
      }}
      className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2"
    >
      <div className="flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-fg-subtle uppercase">
          {messages.length === 0 ? 'No messages' : 'Response messages'}
        </h3>
        {messages.length > 0 && (
          <InspectorIconButton
            label="Copy response messages"
            onClick={() => {
              void navigator.clipboard?.writeText(all);
            }}
          >
            <Copy size={13} aria-hidden="true" />
          </InspectorIconButton>
        )}
      </div>
      {messages.length === 0 && streaming && <p className="text-sm text-fg-subtle">Waiting for the first message…</p>}
      {messages.length === 0 && !streaming && status === 0 && (
        <p className="text-sm text-fg-subtle">The call completed without a response message.</p>
      )}
      {messages.map((message, index) => (
        <section
          key={`${String(index)}:${message.base64.slice(0, 16)}`}
          data-testid="grpc-response-message"
          className="rounded border border-hairline bg-surface-sunken"
        >
          <header className="flex items-center justify-between border-b border-hairline px-2 py-0.5 font-mono text-xs text-fg-subtle">
            <span>#{index + 1}</span>
            <span>{formatBytes(message.bytes)}</span>
          </header>
          {message.json !== undefined ? (
            <pre className="overflow-auto p-2 font-mono text-xs whitespace-pre text-fg-default select-text">
              {message.json}
            </pre>
          ) : (
            <div className="p-2 text-xs">
              <p className="text-status-warning">{message.problem ?? 'This message did not decode.'}</p>
              <p className="mt-1 font-mono break-all text-fg-subtle">{message.base64}</p>
            </div>
          )}
        </section>
      ))}
    </div>
  );
}

/** The initial metadata (headers) and the trailing metadata (trailers), apart. */
function MetadataView({ exchange }: { readonly exchange: GrpcExchangeSummary }) {
  return (
    <div data-testid="grpc-response-metadata" className="flex flex-col gap-3 overflow-auto p-2">
      <MetadataTable title="Headers" testId="grpc-response-header-row" entries={Object.entries(exchange.headers)} />
      <MetadataTable title="Trailers" testId="grpc-response-trailer-row" entries={Object.entries(exchange.trailers)} />
    </div>
  );
}

function MetadataTable({
  title,
  testId,
  entries,
}: {
  readonly title: string;
  readonly testId: string;
  readonly entries: readonly (readonly [string, string])[];
}) {
  return (
    <section>
      <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">{title}</h3>
      {entries.length === 0 ? (
        <p className="text-sm text-fg-subtle">None.</p>
      ) : (
        <table aria-label={title} className="w-full table-fixed border-collapse font-mono text-xs">
          <tbody>
            {entries.map(([name, value]) => (
              <tr key={name} data-testid={testId} className="align-top">
                <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
                  {name}
                </th>
                <td className="py-0.5 break-words text-fg-default">{value}</td>
              </tr>
            ))}
          </tbody>
        </table>
      )}
    </section>
  );
}

/** The request and response as they went over the wire: HTTP/2 headers and the length-prefixed frames. */
function RawExchange({ exchange }: { readonly exchange: GrpcExchangeSummary }) {
  const decode = (base64: string): string => {
    try {
      return atob(base64);
    } catch {
      return '';
    }
  };
  const total = base64ByteLength(exchange.http.rawResponseBase64);
  return (
    <div data-testid="grpc-response-raw" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
      <section>
        <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">Request</h3>
        <pre className="font-mono text-xs break-all whitespace-pre-wrap text-fg-default">
          {decode(exchange.http.rawRequestBase64)}
        </pre>
      </section>
      <section>
        <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">
          Response{total > 0 && ` · ${formatBytes(total)}`}
        </h3>
        <pre className="font-mono text-xs break-all whitespace-pre-wrap text-fg-default">
          {decode(exchange.http.rawResponseBase64)}
        </pre>
      </section>
    </div>
  );
}
