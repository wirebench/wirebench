import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { formatBytes, formatClockTime, formatDuration } from '../../lib/format-size.js';
import { responseSize, toneFor } from '../request-editor/response-status.js';
import type { LogEntry, LogSort, SortColumn } from '../../state/exchanges.js';
import { sendIdOf, useExchangesStore } from '../../state/exchanges.js';
import { ipc } from '../../state/ipc-client.js';
import { useSecretsVisibilityStore } from '../../state/secrets-visibility.js';
import { LogDetail, type LogDetailTab } from './log-detail.js';
import { LogFilterBar } from './log-filter-bar.js';
import { LogRowMenu, type LogRowMenuProps } from './log-row-menu.js';
import { nameOf, useNameSources, type NameSources } from './log-name.js';
import { compileMatcher } from './log-search.js';
import { sortEntries } from './log-sort.js';
import { barOf, spanOf, type WaterfallBar } from './log-waterfall.js';
import { LogWaterfallBar } from './log-waterfall-bar.js';
import {
  durationOf,
  matchesFilterWith,
  methodOf,
  protocolOf,
  startedAtOf,
  statusLabelOf,
  urlOf,
} from './log-filter.js';

/** Beyond this many rows the plain map costs more than the virtualiser's bookkeeping. */
const VIRTUALISE_ABOVE = 200;
const ROW_HEIGHT = 22;

/**
 * time · proto · method · name · URL · status · ms · size · waterfall. The status column fits an
 * error code like `connection-refused`.
 */
const COLUMNS = 'grid-cols-[5rem_3rem_4rem_minmax(6rem,12rem)_minmax(0,2fr)_8rem_4rem_5rem_minmax(8rem,1fr)]';
/**
 * What is left when the detail pane takes half the width: proto, method, URL and status. The full
 * seven columns have a min-content width the narrowed table cannot go below, so they would overflow
 * it and slide under the detail rather than truncate.
 */
const COLUMNS_COMPACT = 'grid-cols-[3rem_4rem_minmax(0,1fr)_8rem]';

interface RowProps {
  readonly entry: LogEntry;
  readonly selected: boolean;
  readonly onSelect: () => void;
  /** Opens the row menu at the pointer (right-click). */
  readonly onMenu: (anchor: { x: number; y: number }) => void;
  /** True while a detail pane shares the width, so the row shows only its four narrow columns. */
  readonly compact: boolean;
  /** What the Name cell resolves the row's request against. */
  readonly names: NameSources;
  /** Where the row sits in the Waterfall column; undefined while compact. */
  readonly bar: WaterfallBar | undefined;
}

function LogRow({ entry, selected, onSelect, onMenu, compact, names, bar }: RowProps) {
  const bad = entry.kind === 'failure' || toneFor(entry.exchange) === 'bad';
  return (
    <button
      type="button"
      data-testid="http-log-row"
      data-kind={entry.kind}
      data-send-id={sendIdOf(entry)}
      onClick={onSelect}
      onContextMenu={(event) => {
        event.preventDefault();
        onSelect();
        onMenu({ x: event.clientX, y: event.clientY });
      }}
      aria-pressed={selected}
      title={entry.kind === 'failure' ? entry.failure.error.message : undefined}
      className={`grid ${compact ? COLUMNS_COMPACT : COLUMNS} w-full items-center gap-2 px-2 text-left font-mono text-xs ${
        selected ? 'bg-surface-selected text-fg-default' : 'text-fg-muted hover:bg-surface-hover'
      }`}
      style={{ height: ROW_HEIGHT }}
    >
      {!compact && <span>{formatClockTime(startedAtOf(entry))}</span>}
      <span>{protocolOf(entry)}</span>
      <span>{methodOf(entry)}</span>
      {!compact && (
        <span className="truncate" title={nameOf(entry, names, true)}>
          {nameOf(entry, names)}
        </span>
      )}
      <span className="truncate" title={urlOf(entry)}>
        {urlOf(entry)}
      </span>
      <span data-testid="http-log-status" className={`truncate ${bad ? 'text-status-danger' : 'text-status-success'}`}>
        {statusLabelOf(entry)}
      </span>
      {!compact && <span>{formatDuration(durationOf(entry))}</span>}
      {!compact && <span>{entry.kind === 'exchange' ? formatBytes(responseSize(entry.exchange)) : ''}</span>}
      {!compact && <span>{bar !== undefined && <LogWaterfallBar bar={bar} />}</span>}
    </button>
  );
}

/** A column label that sorts on click: ascending, descending, then back to log order. */
function SortHeader({
  label,
  column,
  sort,
  onSort,
}: {
  readonly label: string;
  readonly column: SortColumn;
  readonly sort: LogSort | undefined;
  readonly onSort: (column: SortColumn) => void;
}) {
  const direction = sort?.column === column ? sort.direction : undefined;
  return (
    <span
      role="columnheader"
      aria-sort={direction === undefined ? 'none' : direction === 'asc' ? 'ascending' : 'descending'}
      className="min-w-0"
    >
      <button
        type="button"
        onClick={() => {
          onSort(column);
        }}
        className={`truncate text-left hover:text-fg-default ${direction === undefined ? '' : 'text-fg-default'}`}
      >
        {label}
        {direction === 'asc' ? ' ▲' : direction === 'desc' ? ' ▼' : ''}
      </button>
    </span>
  );
}

/**
 * The console's HTTP Log tab: one row per send this session — finished or failed — newest at the
 * bottom, narrowed by the filter bar, with the selected row's detail underneath in tabs.
 */
export function HttpLog() {
  const log = useExchangesStore((state) => state.log);
  const filter = useExchangesStore((state) => state.filter);
  const sort = useExchangesStore((state) => state.sort);
  const cycleSort = useExchangesStore((state) => state.cycleSort);
  const clearLog = useExchangesStore((state) => state.clearLog);
  const refreshExchange = useExchangesStore((state) => state.refreshExchange);
  const showSecrets = useSecretsVisibilityStore((state) => state.show);
  const toggleSecrets = useSecretsVisibilityStore((state) => state.toggle);
  const [selectedId, setSelectedId] = useState<string | undefined>(undefined);
  // Owned here rather than in the detail so it survives selecting another row.
  const [tab, setTab] = useState<LogDetailTab>('headers');
  const scrollRef = useRef<HTMLDivElement>(null);
  // The row menu, keyed by send id so it follows the row through a refresh of its entry.
  const [menu, setMenu] = useState<{ sendId: string; anchor: LogRowMenuProps['anchor'] } | undefined>(undefined);
  const pinnedToBottom = useRef(true);

  const names = useNameSources();
  const nameOfEntry = useCallback((entry: LogEntry) => nameOf(entry, names), [names]);
  const matcher = useMemo(
    () => compileMatcher({ text: filter.text, regex: filter.regex, matchCase: filter.matchCase }),
    [filter.text, filter.regex, filter.matchCase],
  );
  // The displayed order: filtered, then sorted. The arrow keys walk this, so they follow the sort.
  const visible = useMemo(
    () =>
      sortEntries(
        log.filter((entry) => matchesFilterWith(entry, filter, matcher, nameOfEntry)),
        sort,
        nameOfEntry,
      ),
    [log, filter, matcher, nameOfEntry, sort],
  );

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
  // The detail shares the width with the table, so the row sheds the columns that do not fit.
  const compact = selected !== undefined;
  // One span for the rows shown, so every bar is placed on the same time axis.
  const span = useMemo(() => spanOf(visible), [visible]);
  const barFor = (entry: LogEntry): WaterfallBar | undefined =>
    compact || span === undefined ? undefined : barOf(entry, span);

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

  // Newest is at the bottom, so follow it — but only while the user has not scrolled away, and only
  // in log order: a sorted table puts a new row wherever it sorts to.
  useEffect(() => {
    const element = scrollRef.current;
    if (element !== null && pinnedToBottom.current && sort === undefined) {
      element.scrollTop = element.scrollHeight;
    }
  }, [log.length, sort]);

  function onKeyDown(event: React.KeyboardEvent<HTMLDivElement>): void {
    if ((event.key === 'ContextMenu' || (event.key === 'F10' && event.shiftKey)) && selectedId !== undefined) {
      event.preventDefault();
      const escaped =
        typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(selectedId) : selectedId;
      const row = scrollRef.current?.querySelector<HTMLElement>(`[data-send-id="${escaped}"]`);
      if (row !== null && row !== undefined) {
        setMenu({ sendId: selectedId, anchor: row });
      }
      return;
    }
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
      } else {
        // Nothing is virtualised, so the row is already in the DOM; bring it into view.
        const id = sendIdOf(entry);
        const escaped = typeof CSS !== 'undefined' && typeof CSS.escape === 'function' ? CSS.escape(id) : id;
        scrollRef.current
          ?.querySelector<HTMLElement>(`[data-send-id="${escaped}"]`)
          ?.scrollIntoView({ block: 'nearest' });
      }
    }
  }

  const menuEntry = menu === undefined ? undefined : log.find((entry) => sendIdOf(entry) === menu.sendId);

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
            <Button
              variant="ghost"
              disabled={visible.length === 0}
              title="Export the rows shown as a HAR file (secrets are always masked)"
              onClick={() => {
                void (async () => {
                  const result = await ipc().log.exportHar({ entries: [...visible] });
                  if (!result.ok) showToast(result.error.message);
                  else if (result.value.saved && result.value.path !== undefined)
                    showToast(`Saved ${result.value.path}`);
                })();
              }}
            >
              Export HAR
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
              className={`grid ${compact ? COLUMNS_COMPACT : COLUMNS} min-w-0 flex-1 gap-2 font-mono text-xs text-fg-faint`}
            >
              {!compact && <SortHeader label="time" column="time" sort={sort} onSort={cycleSort} />}
              <span>proto</span>
              <span>method</span>
              {!compact && <SortHeader label="name" column="name" sort={sort} onSort={cycleSort} />}
              <span>URL</span>
              <SortHeader label="status" column="status" sort={sort} onSort={cycleSort} />
              {!compact && <SortHeader label="ms" column="duration" sort={sort} onSort={cycleSort} />}
              {!compact && <SortHeader label="size" column="size" sort={sort} onSort={cycleSort} />}
              {!compact && <span>waterfall</span>}
            </div>
          </div>

          <div
            ref={scrollRef}
            aria-label="HTTP log"
            tabIndex={0}
            onKeyDown={onKeyDown}
            /* Two rows at least: in a short console the panel scrolls rather than leaving the
               table with no height at all. */
            className="min-h-11 flex-1 overflow-auto"
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
                        compact={compact}
                        names={names}
                        bar={barFor(entry)}
                        selected={sendIdOf(entry) === selectedId}
                        onSelect={() => {
                          setSelectedId(sendIdOf(entry));
                        }}
                        onMenu={(anchor) => {
                          setMenu({ sendId: sendIdOf(entry), anchor });
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
                  compact={compact}
                  names={names}
                  bar={barFor(entry)}
                  selected={sendIdOf(entry) === selectedId}
                  onSelect={() => {
                    setSelectedId(sendIdOf(entry));
                  }}
                  onMenu={(anchor) => {
                    setMenu({ sendId: sendIdOf(entry), anchor });
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
            onMenu={(anchor) => {
              setMenu({ sendId: sendIdOf(selected), anchor });
            }}
          />
        )}
      </div>

      {menuEntry !== undefined && menu !== undefined && (
        <LogRowMenu
          entry={menuEntry}
          anchor={menu.anchor}
          onClose={() => {
            setMenu(undefined);
          }}
          returnFocus={() => {
            scrollRef.current?.focus();
          }}
        />
      )}
    </div>
  );
}
