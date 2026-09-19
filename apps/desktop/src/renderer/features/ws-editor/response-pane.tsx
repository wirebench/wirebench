/**
 * The WebSocket response half: the status line, then Timeline, Handshake, Timing and TLS, and the
 * composer under the timeline.
 *
 * A session has no single response. What it has is a handshake (the `101` and what was agreed:
 * extension, subprotocol), a running length, and a conversation — so the line reads
 * `101 · permessage-deflate · chat.v2 · 00:42 · ↑3 ↓17 · 4.1 KB`, leaving out whatever the session
 * did not have, with the clock ticking while it is open. While the session runs the pane reads the
 * store's live half; once it closes the finished exchange replaces it, holding the same frames.
 * Timing and TLS are the panes every other protocol uses, fed from the handshake.
 */
import { useEffect, useState } from 'react';
import { Tabs } from '../../components/tabs.js';
import { formatBytes } from '../../lib/format-size.js';
import type { IpcError } from '../../../shared/ipc.js';
import type { WsFrameWire, WsHandshakeWire } from '../../../shared/wire-types.js';
import type { WsExchangeState } from '../../state/exchanges.js';
import { TimingsBar } from '../console/timings-bar.js';
import { TlsDetails } from '../request-editor/inspectors/ssl-inspector.js';
import { WsComposer, type WsComposerProps } from './composer.js';
import { WsFrameDetail } from './frame-detail.js';
import { WsTimeline } from './timeline.js';
import { formatElapsed } from './ws-format.js';

const TABS = [
  { id: 'timeline', label: 'Timeline' },
  { id: 'handshake', label: 'Handshake' },
  { id: 'timing', label: 'Timing' },
  { id: 'tls', label: 'TLS' },
] as const;

type TabId = (typeof TABS)[number]['id'];

/** What the status line is made of; every optional part is left out when absent. */
export interface WsStatusSummary {
  readonly status?: number | undefined;
  readonly extensions?: string | undefined;
  readonly protocol?: string | undefined;
  readonly elapsedMs?: number | undefined;
  readonly sent: number;
  readonly received: number;
  readonly bytes: number;
}

/** `101 · permessage-deflate · chat.v2 · 00:42 · ↑3 ↓17 · 4.1 KB`, without the parts that are absent. */
export function wsStatusText(summary: WsStatusSummary): string {
  const parts: string[] = [];
  if (summary.status !== undefined) parts.push(String(summary.status));
  if (summary.extensions !== undefined && summary.extensions !== '') parts.push(summary.extensions);
  if (summary.protocol !== undefined && summary.protocol !== '') parts.push(summary.protocol);
  if (summary.elapsedMs !== undefined) parts.push(formatElapsed(summary.elapsedMs));
  parts.push(`↑${String(summary.sent)} ↓${String(summary.received)}`);
  if (summary.bytes > 0) parts.push(formatBytes(summary.bytes));
  return parts.join(' · ');
}

/** Whether a frame is a message (text or binary) rather than a control frame. */
function isData(frame: WsFrameWire): boolean {
  return frame.opcode === 'text' || frame.opcode === 'binary';
}

/** The status line's parts for a request's session, live or finished; `undefined` before any handshake. */
export function wsStatusSummary(state: WsExchangeState | undefined, now: number): WsStatusSummary | undefined {
  const exchange = state?.exchange;
  if (exchange !== undefined) {
    return {
      status: exchange.handshake.status,
      extensions: exchange.handshake.extensions,
      protocol: exchange.handshake.protocol,
      elapsedMs: exchange.durationMs,
      sent: exchange.counts.sent,
      received: exchange.counts.received,
      bytes: exchange.counts.bytesSent + exchange.counts.bytesReceived,
    };
  }
  const live = state?.live;
  const handshake = live?.handshake;
  if (live === undefined || handshake === undefined) {
    return undefined;
  }
  const data = live.frames.filter(isData);
  const started = Date.parse(handshake.startedAt);
  return {
    status: handshake.status,
    extensions: handshake.extensions,
    protocol: handshake.protocol,
    ...(Number.isNaN(started) ? {} : { elapsedMs: now - started }),
    sent: data.filter((frame) => frame.direction === 'sent').length,
    received: data.filter((frame) => frame.direction === 'received').length,
    bytes: data.reduce((sum, frame) => sum + frame.size, 0),
  };
}

export interface WsStatusLineProps {
  readonly state: WsExchangeState | undefined;
}

/** The status line, ticking once a second while the session is open. */
export function WsStatusLine({ state }: WsStatusLineProps) {
  const [now, setNow] = useState(() => Date.now());
  const open = state?.status === 'open';
  useEffect(() => {
    if (!open) return undefined;
    setNow(Date.now());
    const timer = setInterval(() => {
      setNow(Date.now());
    }, 1000);
    return () => {
      clearInterval(timer);
    };
  }, [open]);

  const error: IpcError | undefined = state?.error;
  if (
    state?.status === 'error' ||
    (error !== undefined && state?.live === undefined && state?.exchange === undefined)
  ) {
    return (
      <p role="status" data-testid="ws-response-status" className="truncate px-2 font-mono text-xs text-status-danger">
        {error === undefined ? 'The handshake failed.' : `${error.code} · ${error.message}`}
      </p>
    );
  }
  if (state?.status === 'connecting') {
    return (
      <p role="status" data-testid="ws-response-status" className="px-2 font-mono text-xs text-fg-muted">
        Connecting…
      </p>
    );
  }
  const summary = wsStatusSummary(state, now);
  if (summary === undefined) {
    return null;
  }
  return <WsSummaryLine summary={summary} />;
}

/** One status line from a summary already made — the History view has no live state to read. */
export function WsSummaryLine({ summary }: { readonly summary: WsStatusSummary }) {
  return (
    <p role="status" data-testid="ws-response-status" className="truncate px-2 font-mono text-xs text-fg-muted">
      {wsStatusText(summary)}
    </p>
  );
}

/** The timeline with the selected frame's detail under it; shared by the editor and History. */
export function WsTimelineWithDetail({
  frames,
  droppedFrames,
}: {
  readonly frames: readonly WsFrameWire[];
  readonly droppedFrames?: number | undefined;
}) {
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const frame = selected === undefined ? undefined : frames.find((candidate) => candidate.index === selected);
  return (
    <div className="flex min-h-0 flex-1 flex-col">
      <div className={`flex min-h-0 flex-col ${frame === undefined ? 'flex-1' : 'basis-1/2'}`}>
        <WsTimeline frames={frames} selectedIndex={selected} onSelect={setSelected} droppedFrames={droppedFrames} />
      </div>
      {frame !== undefined && (
        <div className="flex min-h-0 basis-1/2 flex-col">
          <WsFrameDetail frame={frame} />
        </div>
      )}
    </div>
  );
}

/** The handshake: the request head as sent and the response status and headers. */
export function WsHandshakeView({ handshake }: { readonly handshake: WsHandshakeWire | undefined }) {
  if (handshake === undefined) {
    return <p className="p-3 text-sm text-fg-subtle">Connect to see the handshake.</p>;
  }
  return (
    <div data-testid="ws-handshake" className="flex flex-col gap-3 overflow-auto p-2">
      <section>
        <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">Request</h3>
        {handshake.rawRequestHead !== undefined ? (
          <pre className="font-mono text-xs break-all whitespace-pre-wrap text-fg-default select-text">
            {handshake.rawRequestHead}
          </pre>
        ) : (
          <>
            <p className="mb-1 font-mono text-xs text-fg-default">{`GET ${handshake.url}`}</p>
            <HeaderTable title="Request headers" headers={handshake.requestHeaders} />
            <p className="mt-1 text-xs text-fg-subtle">
              The headers asked for; the sec-websocket-* headers the transport adds are not shown.
            </p>
          </>
        )}
      </section>
      <section>
        <h3 className="mb-1 text-xs tracking-wider text-fg-subtle uppercase">Response</h3>
        {handshake.error !== undefined && <p className="mb-1 text-xs text-status-danger">{handshake.error}</p>}
        {handshake.status !== undefined && (
          <p className="mb-1 font-mono text-xs text-fg-default">
            {`${String(handshake.status)}${handshake.statusText !== undefined ? ` ${handshake.statusText}` : ''}`}
          </p>
        )}
        <HeaderTable title="Response headers" headers={handshake.responseHeaders ?? {}} />
      </section>
    </div>
  );
}

function HeaderTable({
  title,
  headers,
}: {
  readonly title: string;
  readonly headers: Readonly<Record<string, string>>;
}) {
  const entries = Object.entries(headers);
  if (entries.length === 0) {
    return <p className="text-sm text-fg-subtle">None.</p>;
  }
  return (
    <table aria-label={title} className="w-full table-fixed border-collapse font-mono text-xs">
      <tbody>
        {entries.map(([name, value]) => (
          <tr key={name} className="align-top">
            <th scope="row" className="w-1/3 py-0.5 pr-2 text-left font-medium break-words text-fg-muted">
              {name}
            </th>
            <td className="py-0.5 break-words text-fg-default">{value}</td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export interface WsResponsePaneProps {
  readonly state: WsExchangeState | undefined;
  /** Sends one composed message; absent where the pane is read-only. */
  readonly onSend?: WsComposerProps['onSend'] | undefined;
  readonly sendShortcut?: string | undefined;
}

/** The response pane. */
export function WsResponsePane({ state, onSend, sendShortcut }: WsResponsePaneProps) {
  const [tab, setTab] = useState<TabId>('timeline');
  const exchange = state?.exchange;
  const live = state?.live;
  const frames = exchange?.frames ?? live?.frames ?? [];
  const handshake = live?.handshake ?? exchange?.handshake;
  const open = state?.status === 'open';

  const items = TABS.map((item) =>
    item.id === 'timeline' && frames.length > 0 ? { ...item, badge: String(frames.length) } : item,
  );

  return (
    <section aria-label="Session" data-testid="ws-response" className="flex h-full min-h-0 flex-col">
      <div className="flex h-row shrink-0 items-center border-b border-hairline">
        <div className="min-w-0 flex-1">
          <WsStatusLine state={state} />
        </div>
      </div>
      <Tabs label="Session tabs" items={items} active={tab} onSelect={setTab} />
      <div className="flex min-h-0 flex-1 flex-col overflow-hidden">
        {tab === 'timeline' && <WsTimelineWithDetail frames={frames} droppedFrames={live?.droppedFrames} />}
        {tab === 'handshake' && <WsHandshakeView handshake={handshake} />}
        {tab === 'timing' &&
          (handshake === undefined ? (
            <p className="p-3 text-sm text-fg-subtle">Timing is measured when the handshake settles.</p>
          ) : (
            <div data-testid="ws-response-timing" className="overflow-auto">
              <TimingsBar timings={{ startedAt: handshake.startedAt, totalMs: handshake.durationMs }} />
            </div>
          ))}
        {tab === 'tls' &&
          (handshake === undefined ? (
            <p className="p-3 text-sm text-fg-subtle">The TLS details are read when the handshake settles.</p>
          ) : handshake.tls === undefined ? (
            <p className="p-3 text-sm text-fg-subtle">No TLS — plain ws://. Connect over wss:// to see certificates.</p>
          ) : (
            <div data-testid="ws-response-tls" className="overflow-auto">
              <TlsDetails tls={handshake.tls} />
            </div>
          ))}
      </div>
      {tab === 'timeline' && onSend !== undefined && (
        <WsComposer open={open} onSend={onSend} sendShortcut={sendShortcut} />
      )}
    </section>
  );
}
