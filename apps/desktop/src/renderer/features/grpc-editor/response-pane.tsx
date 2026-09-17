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
import { useState } from 'react';
import { Copy } from 'lucide-react';
import { Tabs } from '../../components/tabs.js';
import type { IpcError } from '../../../shared/ipc.js';
import type { GrpcExchangeSummary } from '../../../shared/wire-types.js';
import { base64ByteLength, formatBytes } from '../../lib/format-size.js';
import type { GrpcExchangeState } from '../../state/exchanges.js';
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
}

/** The `OK (0) · 12 ms · 3 messages · 1.2 KB` line. */
export function GrpcStatusLine({ exchange, error, sending = false }: GrpcStatusLineProps) {
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
        Sending…
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
}

/** The response pane. */
export function GrpcResponsePane({ state }: GrpcResponsePaneProps) {
  const [tab, setTab] = useState<TabId>('messages');
  const exchange = state?.exchange;
  const sending = state?.status === 'sending';

  const items = TABS.map((item) =>
    item.id === 'messages' && exchange !== undefined && exchange.responseMessages.length > 0
      ? { ...item, badge: String(exchange.responseMessages.length) }
      : item,
  );

  return (
    <section aria-label="Response" data-testid="grpc-response" className="flex h-full min-h-0 flex-col">
      <div className="flex h-row shrink-0 items-center gap-2 border-b border-hairline">
        <div className="min-w-0 flex-1">
          <GrpcStatusLine
            {...(exchange !== undefined ? { exchange } : {})}
            {...(state?.error !== undefined ? { error: state.error } : {})}
            sending={sending}
          />
        </div>
      </div>

      {exchange === undefined ? (
        <p className="p-3 text-sm text-fg-subtle">{sending ? 'Sending…' : 'Send the request to see its response.'}</p>
      ) : (
        <>
          <Tabs label="Response tabs" items={items} active={tab} onSelect={setTab} />
          <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
            {tab === 'messages' && <MessagesView exchange={exchange} />}
            {tab === 'metadata' && <MetadataView exchange={exchange} />}
            {tab === 'timing' && (
              <div data-testid="grpc-response-timing" className="overflow-auto">
                <TimingsBar timings={exchange.http.timings} />
              </div>
            )}
            {tab === 'tls' && (
              <div data-testid="grpc-response-tls" className="overflow-auto">
                <SslInspector http={exchange.http} />
              </div>
            )}
            {tab === 'raw' && <RawExchange exchange={exchange} />}
          </div>
        </>
      )}
    </section>
  );
}

/** The decoded response messages, in order, each with its size; one that did not decode says why. */
function MessagesView({ exchange }: { readonly exchange: GrpcExchangeSummary }) {
  const all = exchange.responseMessages.map((message) => message.json ?? '').join('\n');
  return (
    <div data-testid="grpc-response-messages" className="flex min-h-0 flex-1 flex-col gap-2 overflow-auto p-2">
      <div className="flex items-center justify-between">
        <h3 className="text-xs tracking-wider text-fg-subtle uppercase">
          {exchange.responseMessages.length === 0 ? 'No messages' : 'Response messages'}
        </h3>
        {exchange.responseMessages.length > 0 && (
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
      {exchange.responseMessages.length === 0 && exchange.status === 0 && (
        <p className="text-sm text-fg-subtle">The call completed without a response message.</p>
      )}
      {exchange.responseMessages.map((message, index) => (
        <section
          key={index}
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
