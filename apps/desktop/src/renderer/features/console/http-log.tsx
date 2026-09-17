import { useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../components/button.js';
import { formatBytes, formatClockTime, formatDuration } from '../../lib/format-size.js';
import { responseSize, toneFor } from '../request-editor/response-status.js';
import type { LogEntry } from '../../state/exchanges.js';
import { sendIdOf, useExchangesStore } from '../../state/exchanges.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import { LogDetail, type LogDetailTab } from './log-detail.js';
import { LogFilterBar } from './log-filter-bar.js';
import { durationOf, matchesFilter, methodOf, protocolOf, startedAtOf, urlOf } from './log-filter.js';

/** Beyond this many rows the plain map costs more than the virtualiser's bookkeeping. */
const VIRTUALISE_ABOVE = 200;
const ROW_HEIGHT = 22;

/** time · proto · method · URL · status · ms · size. The status column fits an error code like `connection-refused`. */
const COLUMNS = 'grid-cols-[5rem_3rem_4rem_minmax(0,1fr)_8rem_4rem_5rem]';

interface RowProps {
  readonly entry: LogEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
}

function LogRow({ entry, selected, onSelect }: RowProps) {
  const bad = entry.kind === 'failure' || toneFor(entry.exchange) === 'bad';
  return (
    <button
      type="button"
      data-testid="http-log-row"
      data-kind={entry.kind}
      onClick={onSelect}
      aria-pressed={selected}
      title={entry.kind === 'failure' ? entry.failure.error.message : undefined}
      className={`grid ${COLUMNS} w-full items-center gap-2 px-2 text-left font-mono text-xs ${
        selected ? 'bg-surface-selected text-fg-default' : 'text-fg-muted hover:bg-surface-hover'
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      <span>{formatClockTime(startedAtOf(entry))}</span>
      <span>{protocolOf(entry)}</span>
      <span>{methodOf(entry)}</span>
      <span className="truncate" title={urlOf(entry)}>
        {urlOf(entry)}
      </span>
      <span data-testid="http-log-status" className={`truncate ${bad ? 'text-status-danger' : 'text-status-success'}`}>
        {entry.kind === 'failure' ? entry.failure.error.code : entry.exchange.http.status}
      </span>
      <span>{formatDuration(durationOf(entry))}</span>
      <span>{entry.kind === 'exchange' ? formatBytes(responseSize(entry.exchange)) : ''}</span>
    </button>
  );
}

/**
 * The console's HTTP Log tab: one row per send this session — finished or failed — newest at the
 * bottom, narrowed by the filter bar, with the selected row's detail underneath in tabs.
 */
export function HttpLog() {
  const log = useExchangesStore((state) => state.log);
  const filter = useExchangesStore((state) => state.filter);
  const clearLog = useExchangesStore((state) => state.clearLog);
  const refreshExchange = useExchangesStore((state) => state.refreshExchange);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const toggleSecrets = useSecretsVisibilityStore((state) => state.toggle);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Owned here rather than in the detail so it survives selecting another row.
  const [tab, setTab] = useState<LogDetailTab>('headers');
  const scrollRef = useRef<HTMLDivElement>(null);
  const pinnedToBottom = useRef(true);

  const visible = useMemo(() => log.filter((entry) => matchesFilter(entry, filter)), [log, filter]);

  const virtualised = visible.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtualised ? visible.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  // Looked up in `visible`, not `log`, so a row hidden by the filter closes its detail pane
  // rather than keeping a stale one open; `selectedId` itself is untouched, so the detail
  // reappears once the filter is cleared.
  const selected = visible.find((entry) => sendIdOf(entry) === selectedId);

  // Redaction is applied in main, once, at send time — so when the flag flips, the exchange the
  // user is looking at has to be re-fetched (`exchanges.get`) to be re-redacted. A failure row has
  // no unredacted copy to fetch: it was redacted at emit and stays so, and main is not asked.
  // Keyed on the id, not the entry: the refresh swaps in a new entry object, which must not re-fire it.
  const selectedExchangeId = selected?.kind === 'exchange' ? selected.exchange.sendId : undefined;
  useEffect(() => {
    if (selectedExchangeId !== undefined) {
      void refreshExchange(selectedExchangeId);
    }
  }, [showSecrets, selectedExchangeId, refreshExchange]);

  // Newest is at the bottom, so follow it — but only while the user has not scrolled away.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && pinnedToBottom.current) {
      element.scrollTop = element.scrollHeight;
    }
  }, [log.length]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if (event.key === 'Escape' && selectedId !== undefined) {
      event.preventDefault();
      setSelectedId(undefined);
      return;
    }
    const step = event.key === 'ArrowDown' ? 1 : event.key === 'ArrowUp' ? -1 : 0;
    if (step === 0 || visible.length === 0) {
      return;
    }
    event.preventDefault();
    const index = visible.findIndex((entry) => sendIdOf(entry) === selectedId);
    const next =
      index === -1 ? (step === 1 ? 0 : visible.length - 1) : Math.min(visible.length - 1, Math.max(0, index + step));
    const entry = visible[next];
    if (entry !== undefined) {
      setSelectedId(sendIdOf(entry));
      if (virtualised) {
        virtualizer.scrollToIndex(next);
      }
    }
  }

  if (log.length === 0) {
    return <p className="p-1 text-sm text-fg-subtle">Sent requests appear here with their raw exchange and timings.</p>;
  }

  return (
    <div className="flex h-full min-h-0 flex-col">
      <LogFilterBar
        shown={visible.length}
        total={log.length}
        actions={
          <>
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
          </>
        }
      />

      <div className="flex min-h-0 flex-1">
        <div className={`flex min-h-0 min-w-0 flex-col ${selected === undefined ? 'flex-1' : 'basis-[45%] shrink-0'}`}>
          <div className="flex shrink-0 items-center justify-between gap-2 border-b border-hairline px-2 py-1">
            <div
              data-testid="http-log-header"
              className={`grid ${COLUMNS} min-w-0 flex-1 gap-2 font-mono text-xs text-fg-faint`}
            >
              <span>time</span>
              <span>proto</span>
              <span>method</span>
              <span>URL</span>
              <span>status</span>
              <span>ms</span>
              <span>size</span>
            </div>
          </div>

          <div
            ref={scrollRef}
            aria-label="HTTP log"
            tabIndex={0}
            onKeyDown={onKeyDown}
            className="min-h-0 flex-1 overflow-auto"
            onScroll={(event) => {
              const element = event.currentTarget;
              pinnedToBottom.current = element.scrollHeight - element.scrollTop - element.clientHeight < ROW_HEIGHT;
            }}
          >
            {visible.length === 0 ? (
              <p className="p-1 text-sm text-fg-subtle">No rows match the filter.</p>
            ) : virtualised ? (
              <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
                {virtualizer.getVirtualItems().map((item) => {
                  const entry = visible[item.index];
                  return entry === undefined ? null : (
                    <div
                      key={sendIdOf(entry)}
                      style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: item.size }}
                    >
                      <LogRow
                        entry={entry}
                        selected={sendIdOf(entry) === selectedId}
                        onSelect={() => {
                          setSelectedId(sendIdOf(entry));
                        }}
                      />
                    </div>
                  );
                })}
              </div>
            ) : (
              visible.map((entry) => (
                <LogRow
                  key={sendIdOf(entry)}
                  entry={entry}
                  selected={sendIdOf(entry) === selectedId}
                  onSelect={() => {
                    setSelectedId(sendIdOf(entry));
                  }}
                />
              ))
            )}
          </div>
        </div>

        {selected !== undefined && (
          <LogDetail
            entry={selected}
            tab={tab}
            onTabChange={setTab}
            onClose={() => {
              setSelectedId(undefined);
            }}
          />
        )}
      </div>
    </div>
  );
}
