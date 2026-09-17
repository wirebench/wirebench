/**
 * The HTTP Log's detail pane: one selected row, in five tabs — Headers, Request, Response, Timing,
 * Connection — each of which renders for a finished exchange and for a failed send. The selected
 * tab is owned by the parent so it survives selecting another row.
 */
import { Tabs, type TabItem } from '../../components/tabs.js';
import { base64ByteLength, decodeBase64Text, formatDuration } from '../../lib/format-size.js';
import type { LogEntry } from '../../state/exchanges.js';
import { SslInspector } from '../request-editor/inspectors/ssl-inspector.js';
import { RedirectsView } from '../rest-editor/response/redirects-view.js';
import { TimingsBar } from './timings-bar.js';
import type { FailedExchangeWire, HttpExchangeWire } from '../../../shared/wire-types.js';

export type LogDetailTab = 'headers' | 'request' | 'response' | 'timing' | 'connection';

const TABS: readonly TabItem<LogDetailTab>[] = [
  { id: 'headers', label: 'Headers' },
  { id: 'request', label: 'Request' },
  { id: 'response', label: 'Response' },
  { id: 'timing', label: 'Timing' },
  { id: 'connection', label: 'Connection' },
];

/** Matches C0 control characters other than tab/CR/LF — the cheap "this is not text" signal. */
const BINARY_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function rawText(base64: string): string {
  const text = decodeBase64Text(base64);
  if (text === undefined || BINARY_PATTERN.test(text)) {
    return `<${String(base64ByteLength(base64))} bytes>`;
  }
  return text;
}

/** The transport's phases in wire order, with why each can be missing. */
const PHASES: readonly {
  readonly id: string;
  readonly key: keyof HttpExchangeWire['timings'];
  readonly reason: string;
}[] = [
  { id: 'dns', key: 'dnsMs', reason: 'DNS is not measured: the transport has no lookup timer, by design.' },
  {
    id: 'connect',
    key: 'connectMs',
    reason:
      'Not measured: the send reused a keep-alive connection, or several sends were in flight and the connect could not be attributed to this one.',
  },
  {
    id: 'tls',
    key: 'tlsMs',
    reason: 'Not measured: plain HTTP, a reused keep-alive connection, or several sends in flight.',
  },
  { id: 'ttfb', key: 'ttfbMs', reason: 'Not measured: the response headers never arrived.' },
  { id: 'download', key: 'downloadMs', reason: 'Not measured: the response body was never read.' },
];

/** Pulls `CN=…` (the peer subject) out of the engine's `tls-untrusted` message, when it carries one. */
function peerSubjectOf(message: string): string | undefined {
  const match = /certificate for (.+?) is not trusted/.exec(message);
  return match?.[1];
}

function HeaderTable({
  label,
  testId,
  rows,
}: {
  readonly label: string;
  readonly testId: string;
  readonly rows: readonly (readonly [string, string])[];
}) {
  return (
    <section aria-label={label} data-testid={testId} className="flex min-w-0 flex-col gap-1">
      <h3 className="text-xs tracking-wider text-fg-subtle uppercase">{label}</h3>
      {rows.length === 0 ? (
        <p className="text-xs text-fg-subtle">None.</p>
      ) : (
        <table className="w-full table-fixed border-collapse font-mono text-xs">
          <tbody>
            {rows.map(([name, value], index) => (
              <tr key={`${name}:${String(index)}`} className="align-top">
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

function RawPane({ label, base64 }: { readonly label: string; readonly base64: string }) {
  return (
    <section aria-label={label} className="p-2">
      <pre className="max-h-64 overflow-auto rounded bg-surface-raised p-2 font-mono text-xs whitespace-pre-wrap text-fg-default">
        {rawText(base64)}
      </pre>
    </section>
  );
}

function ExchangeHeaders({ http }: { readonly http: HttpExchangeWire }) {
  return (
    <div className="grid grid-cols-2 gap-3 p-2">
      <HeaderTable
        label="Request headers"
        testId="log-detail-request-headers"
        rows={Object.entries(http.request.headers)}
      />
      <HeaderTable label="Response headers" testId="log-detail-response-headers" rows={http.rawHeaders} />
    </div>
  );
}

function FailureHeaders({ failure }: { readonly failure: FailedExchangeWire }) {
  return (
    <div className="flex flex-col gap-2 p-2">
      <HeaderTable
        label="Request headers"
        testId="log-detail-request-headers"
        rows={Object.entries(failure.request.headers)}
      />
      <p data-testid="log-detail-redaction-note" className="text-xs text-fg-subtle">
        Headers of a failed send are redacted when they are recorded and stay redacted: no unredacted copy is kept, so
        the show-secrets toggle does not reveal them.
      </p>
    </div>
  );
}

function ExchangeTiming({ http }: { readonly http: HttpExchangeWire }) {
  return (
    <div className="flex flex-col gap-1">
      <TimingsBar timings={http.timings} />
      <ul data-testid="timing-phases" className="flex flex-col gap-0.5 px-2 pb-2 font-mono text-xs">
        {PHASES.map((phase) => {
          const value = http.timings[phase.key];
          return (
            <li key={phase.id} data-phase={phase.id} className="flex flex-wrap gap-x-2">
              <span className="w-20 text-fg-muted">{`${phase.id} `}</span>
              {typeof value === 'number' ? (
                <span className="text-fg-default">{`${String(Math.round(value))} ms`}</span>
              ) : (
                <>
                  <span className="text-fg-subtle">{'n/a '}</span>
                  <span className="font-sans text-fg-subtle">{phase.reason}</span>
                </>
              )}
            </li>
          );
        })}
      </ul>
    </div>
  );
}

function FailureTiming({ failure }: { readonly failure: FailedExchangeWire }) {
  return (
    <div className="flex flex-col gap-1 px-2 py-1 font-mono text-xs">
      <p data-testid="timings-total" className="text-fg-default">
        total {formatDuration(failure.durationMs)}
      </p>
      <p className="font-sans text-fg-subtle">Phases are not measured for a send that failed.</p>
    </div>
  );
}

function ExchangeConnection({ entry }: { readonly entry: Extract<LogEntry, { kind: 'exchange' }> }) {
  const { exchange } = entry;
  const arrival = 'methodChanged' in exchange ? { method: exchange.method, methodChanged: exchange.methodChanged } : {};
  return (
    <div data-testid="log-detail-connection" className="flex flex-col gap-2">
      <section aria-label="Redirects">
        <h3 className="px-2 pt-2 text-xs tracking-wider text-fg-subtle uppercase">Redirects</h3>
        <RedirectsView http={exchange.http} {...arrival} />
      </section>
      <section aria-label="TLS peer">
        <h3 className="px-2 text-xs tracking-wider text-fg-subtle uppercase">TLS peer</h3>
        <SslInspector http={exchange.http} />
      </section>
    </div>
  );
}

function FailureConnection({ failure }: { readonly failure: FailedExchangeWire }) {
  const peer = failure.error.code === 'tls-untrusted' ? peerSubjectOf(failure.error.message) : undefined;
  return (
    <dl data-testid="log-detail-connection" className="grid grid-cols-[6rem_minmax(0,1fr)] gap-x-2 gap-y-1 p-2 text-xs">
      <dt className="text-fg-subtle">URL</dt>
      <dd className="min-w-0 font-mono break-all text-fg-default">{failure.request.url}</dd>
      <dt className="text-fg-subtle">Method</dt>
      <dd className="font-mono text-fg-default">{failure.request.method}</dd>
      {peer !== undefined && (
        <>
          <dt className="text-fg-subtle">Peer</dt>
          <dd data-testid="log-detail-peer" className="min-w-0 font-mono break-all text-fg-default">
            {peer}
          </dd>
        </>
      )}
    </dl>
  );
}

export interface LogDetailProps {
  readonly entry: LogEntry;
  readonly tab: LogDetailTab;
  readonly onTabChange: (tab: LogDetailTab) => void;
  /** Closes the pane (the × button and Escape); omitted, neither is offered. */
  readonly onClose?: () => void;
}

/** The detail pane beside the HTTP Log table, on its right. */
export function LogDetail({ entry, tab, onTabChange, onClose }: LogDetailProps) {
  return (
    <div
      data-testid="log-detail"
      className="flex min-h-0 min-w-0 flex-1 flex-col border-l border-hairline"
      onKeyDown={(event) => {
        if (event.key === 'Escape' && onClose !== undefined) {
          event.stopPropagation();
          onClose();
        }
      }}
    >
      <div className="flex shrink-0 items-center">
        {onClose !== undefined && (
          <button
            type="button"
            aria-label="Close detail"
            title="Close (Esc)"
            onClick={onClose}
            className="px-2 text-sm text-fg-muted hover:text-fg-default"
          >
            ×
          </button>
        )}
        <div className="min-w-0 flex-1">
          <Tabs label="Log detail" items={TABS} active={tab} onSelect={onTabChange} />
        </div>
      </div>
      <div className="min-h-0 flex-1 overflow-auto">
        {entry.kind === 'exchange' ? (
          <>
            {tab === 'headers' && <ExchangeHeaders http={entry.exchange.http} />}
            {tab === 'request' && <RawPane label="Raw request" base64={entry.exchange.http.rawRequestBase64} />}
            {tab === 'response' && <RawPane label="Raw response" base64={entry.exchange.http.rawResponseBase64} />}
            {tab === 'timing' && <ExchangeTiming http={entry.exchange.http} />}
            {tab === 'connection' && <ExchangeConnection entry={entry} />}
          </>
        ) : (
          <>
            {tab === 'headers' && <FailureHeaders failure={entry.failure} />}
            {tab === 'request' && (
              <p className="p-3 text-sm text-fg-subtle">Raw request was not captured for a failed send.</p>
            )}
            {tab === 'response' && (
              <div data-testid="log-detail-error" className="flex flex-col gap-1 p-3">
                <p className="font-mono text-sm font-medium text-status-danger">{entry.failure.error.code}</p>
                <p className="text-sm text-fg-default">{entry.failure.error.message}</p>
              </div>
            )}
            {tab === 'timing' && <FailureTiming failure={entry.failure} />}
            {tab === 'connection' && <FailureConnection failure={entry.failure} />}
          </>
        )}
      </div>
    </div>
  );
}
