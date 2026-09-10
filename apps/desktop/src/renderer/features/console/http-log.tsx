import { useEffect, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../components/button.js';
import { base64ByteLength, decodeBase64Text, formatBytes, formatClockTime } from '../../lib/format-size.js';
import { responseSize, toneFor } from '../request-editor/response-status.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import type { ExchangeSummary } from '../../../shared/wire-types.js';

/** Beyond this many rows the plain map costs more than the virtualiser's bookkeeping. */
const VIRTUALISE_ABOVE = 200;
const ROW_HEIGHT = 22;

const COLUMNS = 'grid-cols-[5rem_4rem_minmax(0,1fr)_5rem_4rem_5rem]';

/** Matches C0 control characters other than tab/CR/LF — the cheap "this is not text" signal. */
const BINARY_PATTERN = /[\u0000-\u0008\u000b\u000c\u000e-\u001f]/;

function rawText(base64: string): string {
  const text = decodeBase64Text(base64);
  if (text === undefined || BINARY_PATTERN.test(text)) {
    return `<${String(base64ByteLength(base64))} bytes>`;
  }
  return text;
}

interface RowProps {
  readonly exchange: ExchangeSummary;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function LogRow({ exchange, selected, onSelect }: RowProps) {
  const bad = toneFor(exchange) === 'bad';
  return (
    <button
      type="button"
      data-testid="http-log-row"
      onClick={onSelect}
      aria-pressed={selected}
      className={`grid ${COLUMNS} w-full items-center gap-2 px-2 text-left font-mono text-xs ${
        selected ? 'bg-surface-selected text-fg-default' : 'text-fg-muted hover:bg-surface-hover'
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <span>{formatClockTime(exchange.http.timings.startedAt)}</span>
      <span>{exchange.http.request.method}</span>
      <span className="truncate" title={exchange.http.request.url}>
        {exchange.http.request.url}
      </span>
      <span className={bad ? 'text-status-danger' : 'text-status-success'}>{exchange.http.status}</span>
      <span>{exchange.durationMs} ms</span>
      <span>{formatBytes(responseSize(exchange))}</span>
    </button>
  );
}

const TIMING_LABELS = [
  ['total', 'totalMs'],
  ['dns', 'dnsMs'],
  ['connect', 'connectMs'],
  ['tls', 'tlsMs'],
  ['ttfb', 'ttfbMs'],
  ['download', 'downloadMs'],
] as const;

function Detail({ exchange }: { readonly exchange: ExchangeSummary }) {
  const { timings } = exchange.http;

  return (
    <div className="min-h-0 shrink-0 basis-1/2 overflow-auto border-t border-hairline">
      <p className="px-2 py-1 font-mono text-xs text-fg-subtle">
        {TIMING_LABELS.filter(([, key]) => timings[key] !== undefined)
          .map(([label, key]) => `${label} ${String(timings[key])} ms`)
          .join(' · ')}
      </p>
      <div className="grid grid-cols-2 gap-2 p-2">
        <section aria-label="Raw request">
          <h3 className="mb-1 text-xs text-fg-subtle">Raw request</h3>
          <pre className="max-h-48 overflow-auto rounded bg-surface-raised p-2 font-mono text-xs whitespace-pre-wrap text-fg-default">
            {rawText(exchange.http.rawRequestBase64)}
          </pre>
        </section>
        <section aria-label="Raw response">
          <h3 className="mb-1 text-xs text-fg-subtle">Raw response</h3>
          <pre className="max-h-48 overflow-auto rounded bg-surface-raised p-2 font-mono text-xs whitespace-pre-wrap text-fg-default">
            {rawText(exchange.http.rawResponseBase64)}
          </pre>
        </section>
      </div>
    </div>
  );
}

/**
 * The console's HTTP Log tab: one row per finished exchange, newest at the bottom, with the
 * raw request/response of whichever row is selected shown underneath.
 */
export function HttpLog() {
  const log = useExchangesStore((state) => state.log);
  const clearLog = useExchangesStore((state) => state.clearLog);
  const refreshExchange = useExchangesStore((state) => state.refreshExchange);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const toggleSecrets = useSecretsVisibilityStore((state) => state.toggle);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const virtualised = log.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtualised ? log.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Redaction is applied in main, once, at send time — so when the flag flips, the entry the
  // user is looking at has to be re-fetched (`exchanges.get`) to be re-redacted. Only the
  // detail pane shows headers/raw bytes; the row columns carry nothing sensitive.
  useEffect(() => {
    if (selectedId !== undefined) {
      void refreshExchange(selectedId);
    }
  }, [showSecrets, selectedId, refreshExchange]);

  // Newest is at the bottom, so follow it — but only while the user has not scrolled away.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [log.length]);

  const selected = log.find((entry) => entry.sendId === selectedId);

  if (log.length === 0) {
    return <p className="p-1 text-sm text-fg-subtle">Sent requests appear here with their raw exchange and timings.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-2 py-1">
        <div className={`grid ${COLUMNS} min-w-0 flex-1 gap-2 font-mono text-xs text-fg-faint`}>
          <span>time</span>
          <span>method</span>
          <span>URL</span>
          <span>status</span>
          <span>ms</span>
          <span>size</span>
        </div>
        <Button
          variant="ghost"
          aria-pressed={showSecrets}
          title={showSecrets ? 'Secrets are shown — click to redact' : 'Secrets are redacted — click to show'}
          onClick={() => {
            void toggleSecrets();
          }}
        >
          <span aria-hidden="true">{showSecrets ? '🔓' : '🔒'}</span>
          <span className="sr-only">{showSecrets ? 'Hide secrets' : 'Show secrets'}</span>
        </Button>
        <Button variant="ghost" onClick={clearLog}>
          Clear
        </Button>
      </div>

      <div
        ref={scrollRef}
        aria-label="HTTP log"
        className="min-h-0 flex-1 overflow-auto"
        onScroll={(event) => {
          const element = event.currentTarget;
          pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT;
        }}
      >
        {virtualised ? (
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map((item) => {
              const exchange = log[item.index];
              return exchange === undefined ? null : (
                <div
                  key={exchange.sendId}
                  style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: item.size }}
                >
                  <LogRow
                    exchange={exchange}
                    selected={exchange.sendId === selectedId}
                    onSelect={() => {
                      setSelectedId(exchange.sendId);
                    }}
                  />
                </div>
              );
            })}
          </div>
        ) : (
          log.map((exchange) => (
            <LogRow
              key={exchange.sendId}
              exchange={exchange}
              selected={exchange.sendId === selectedId}
              onSelect={() => {
                setSelectedId(exchange.sendId);
              }}
            />
          ))
        )}
      </div>

      {selected !== undefined && <Detail exchange={selected} />}
    </div>
  );
}
