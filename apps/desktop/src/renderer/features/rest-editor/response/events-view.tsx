/**
 * The Events tab of an event-stream response: one row per event, comment and `retry:` line, in the
 * order they arrived, with the selected row's detail under the list.
 *
 * Built on the WebSocket timeline's rules: rows are keyed by their own `index` and memoised, so a new
 * event adds one row rather than repainting the list; each row's lower-cased preview is computed once,
 * so a keystroke in the filter re-reads cached strings; the scroll follows the newest row only while
 * the reader is at the bottom ({@link useFollowBottom}); and past {@link WS_TIMELINE_WINDOW} rows only
 * the rows in view are painted. Comments and retries are rows too, muted, and one toggle hides them.
 */
import { memo, useId, useMemo, useRef, useState, type KeyboardEvent } from 'react';
import { Copy } from 'lucide-react';
import { eventStreamDocument } from '@wirebench/engine/rest';
import { prettyFrameText } from '@wirebench/engine/ws';
import { Button } from '../../../components/button.js';
import { CodeEditor } from '../../../editor/code-editor.js';
import { formatBytes } from '../../../lib/format-size.js';
import type { SseRowWire } from '../../../../shared/wire-types.js';
import { useFollowBottom, WS_TIMELINE_WINDOW } from '../../ws-editor/timeline.js';
import { formatFrameTime } from '../../ws-editor/ws-format.js';

/** Every row is the same height, which is what lets the window be computed from `scrollTop`. */
const ROW_HEIGHT = 24;
/** Rows painted above and below the viewport while windowed. */
const OVERSCAN = 20;
/** The viewport height in rows when layout has not measured one (a hidden pane, a test). */
const FALLBACK_VIEWPORT_ROWS = 40;
/** A preview longer than this is cut: the row shows one line anyway. */
const PREVIEW_CHARS = 300;

/** One line of what a row carried. */
export function rowPreview(row: SseRowWire): string {
  let text: string;
  if (row.kind === 'event') {
    text = row.payloadTruncated === true ? '(data not kept)' : row.data;
  } else if (row.kind === 'comment') {
    text = row.text;
  } else {
    text = `reconnect after ${String(row.ms)} ms`;
  }
  const line = text.length > PREVIEW_CHARS ? text.slice(0, PREVIEW_CHARS) : text;
  return line.replace(/\s+/g, ' ');
}

/**
 * The Query document for these rows (the engine's `eventStreamDocument`). The wire row's optional
 * fields admit an explicit `undefined` the engine's do not; the values are the same.
 */
export function eventsDocument(rows: readonly SseRowWire[]): string {
  return eventStreamDocument(rows as Parameters<typeof eventStreamDocument>[0]);
}

/** What the filter matches a row against, computed once per row object. */
const searchText = new WeakMap<SseRowWire, string>();

function searchTextOf(row: SseRowWire): string {
  let text = searchText.get(row);
  if (text === undefined) {
    const parts = [rowPreview(row)];
    if (row.kind === 'event') {
      parts.push(row.event, row.id ?? '');
      if (row.payloadTruncated !== true && row.data.length > PREVIEW_CHARS) parts.push(row.data);
    }
    text = parts.join(' ').toLowerCase();
    searchText.set(row, text);
  }
  return text;
}

export interface EventsViewProps {
  readonly rows: readonly SseRowWire[];
  /** Rows let go from memory while the stream ran; counted in the total. */
  readonly droppedRows?: number | undefined;
  /** Rows a cap left out of this record; counted in the total. */
  readonly omittedRows?: number | undefined;
  /** A recorded stream (History): nothing more will arrive. */
  readonly readOnly?: boolean | undefined;
}

/** The Events tab: the toolbar, the rows, and the selected row's detail. */
export function EventsView({ rows, droppedRows, omittedRows, readOnly = false }: EventsViewProps) {
  const [showMeta, setShowMeta] = useState(true);
  const [query, setQuery] = useState('');
  const [selected, setSelected] = useState<number | undefined>(undefined);
  const scroller = useRef<HTMLDivElement | null>(null);
  const idPrefix = useId();

  // The stream's real row count: the kept rows plus the ones let go or left out, so the total never
  // falls back or disagrees with the status line's running counts.
  const total = rows.length + (droppedRows ?? 0) + (omittedRows ?? 0);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return rows.filter(
      (row) => (showMeta || row.kind === 'event') && (needle === '' || searchTextOf(row).includes(needle)),
    );
  }, [rows, showMeta, query]);

  const { pinned, scrollTop, onScroll } = useFollowBottom(scroller, visible.length);

  const windowed = visible.length > WS_TIMELINE_WINDOW;
  const measured = scroller.current?.clientHeight ?? 0;
  const viewportRows = measured > 0 ? Math.ceil(measured / ROW_HEIGHT) : FALLBACK_VIEWPORT_ROWS;
  let start = 0;
  let end = visible.length;
  if (windowed) {
    const span = viewportRows + OVERSCAN * 2;
    start = pinned
      ? Math.max(0, visible.length - span)
      : Math.min(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN), Math.max(0, visible.length - span));
    end = Math.min(visible.length, start + span);
  }
  const shown = visible.slice(start, end);
  // Memoised: a live stream re-renders on every row, and a linear find over thousands each time adds up.
  const selectedRow = useMemo(
    () => (selected === undefined ? undefined : rows.find((row) => row.index === selected)),
    [rows, selected],
  );
  const optionId = (index: number): string => `${idPrefix}-row-${String(index)}`;
  const activeShown = selected !== undefined && shown.some((row) => row.index === selected);

  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (visible.length === 0) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = visible.findIndex((row) => row.index === selected);
    const next =
      at === -1
        ? event.key === 'ArrowDown'
          ? 0
          : visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
    setSelected(visible[next]!.index);
    // Keep the selected row in view: rows are one fixed height, so its offset is its position.
    const element = scroller.current;
    if (element !== null) {
      const top = next * ROW_HEIGHT;
      const height = element.clientHeight > 0 ? element.clientHeight : viewportRows * ROW_HEIGHT;
      if (top < element.scrollTop) {
        element.scrollTop = top;
      } else if (top + ROW_HEIGHT > element.scrollTop + height) {
        element.scrollTop = top + ROW_HEIGHT - height;
      }
    }
  };

  return (
    <div data-testid="sse-events" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-2 py-1 text-xs">
        <label className="flex items-center gap-1 text-fg-muted">
          <input
            type="checkbox"
            checked={showMeta}
            onChange={(event) => {
              setShowMeta(event.target.checked);
            }}
          />
          Comments and retries
        </label>
        <input
          type="search"
          aria-label="Filter events"
          placeholder="Filter"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="h-6 min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        />
        <span data-testid="sse-count" className="shrink-0 text-fg-subtle">
          {visible.length === rows.length
            ? `${String(total)} row${total === 1 ? '' : 's'}`
            : `${String(visible.length)} of ${String(total)} rows`}
        </span>
        <Button
          variant="secondary"
          onClick={() => {
            void navigator.clipboard?.writeText(eventsDocument(rows));
          }}
        >
          <Copy size={12} aria-hidden="true" />
          Copy events as JSON
        </Button>
      </div>
      {droppedRows !== undefined && droppedRows > 0 && (
        <p data-testid="sse-dropped" className="shrink-0 px-2 py-1 text-xs text-status-warning">
          {`${String(droppedRows)} earlier rows were let go to keep this long stream light.`}
        </p>
      )}
      <div className={`flex min-h-0 flex-col ${selectedRow === undefined ? 'flex-1' : 'basis-1/2'}`}>
        <div ref={scroller} data-testid="sse-scroller" onScroll={onScroll} className="min-h-0 flex-1 overflow-auto">
          {rows.length === 0 ? (
            <p className="p-2 text-sm text-fg-subtle">{readOnly ? 'No events were recorded.' : 'No events yet.'}</p>
          ) : (
            <ul
              role="listbox"
              aria-label="Events"
              tabIndex={0}
              onKeyDown={move}
              {...(activeShown ? { 'aria-activedescendant': optionId(selected) } : {})}
              className="font-mono text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
            >
              {start > 0 && <li aria-hidden="true" style={{ height: start * ROW_HEIGHT }} />}
              {shown.map((row) => (
                <EventRow
                  key={row.index}
                  id={optionId(row.index)}
                  row={row}
                  selected={row.index === selected}
                  onSelect={setSelected}
                />
              ))}
              {end < visible.length && (
                <li aria-hidden="true" style={{ height: (visible.length - end) * ROW_HEIGHT }} />
              )}
            </ul>
          )}
        </div>
      </div>
      {selectedRow !== undefined && (
        <div className="flex min-h-0 basis-1/2 flex-col">
          <EventDetail key={selectedRow.index} row={selectedRow} />
        </div>
      )}
    </div>
  );
}

/** Memoised: a new row, or a selection change, repaints only the rows it touches. */
const EventRow = memo(function EventRow({
  id,
  row,
  selected,
  onSelect,
}: {
  readonly id: string;
  readonly row: SseRowWire;
  readonly selected: boolean;
  readonly onSelect: (index: number) => void;
}) {
  const muted = row.kind !== 'event';
  const chip = row.kind === 'event' ? row.event : row.kind;
  // On the selection every part reads in the default foreground: the quieter tokens (and the
  // accent) fall short of contrast on the accent-muted background.
  const quiet = selected ? 'text-fg-default' : 'text-fg-subtle';
  return (
    <li
      id={id}
      role="option"
      aria-selected={selected}
      data-testid="sse-row"
      data-muted={muted}
      onClick={() => {
        onSelect(row.index);
      }}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default items-center gap-2 px-2 ${
        selected ? 'bg-accent-muted text-fg-default' : 'hover:bg-surface-raised'
      }`}
    >
      <span className={`w-20 shrink-0 ${quiet}`}>{formatFrameTime(row.at)}</span>
      <span
        data-testid="sse-row-chip"
        className={`max-w-32 shrink-0 truncate rounded-sm border px-1 text-2xs ${
          selected
            ? 'border-hairline-strong text-fg-default'
            : muted
              ? 'border-hairline-strong text-fg-subtle'
              : 'border-hairline-strong text-accent'
        }`}
      >
        {chip}
      </span>
      {row.kind === 'event' && row.id !== undefined && (
        <span className={`max-w-24 shrink-0 truncate ${quiet}`} title={`id ${row.id}`}>
          {row.id}
        </span>
      )}
      <span className={`min-w-0 flex-1 truncate ${muted ? quiet : 'text-fg-default'}`}>{rowPreview(row)}</span>
    </li>
  );
});

/** The selected row: an event's data pretty (JSON, XML) with *Raw*, or what a comment or retry said. */
function EventDetail({ row }: { readonly row: SseRowWire }) {
  const [raw, setRaw] = useState(false);
  const pretty = useMemo(
    () => (row.kind === 'event' && row.payloadTruncated !== true ? prettyFrameText(row.data) : undefined),
    [row],
  );

  const parts = [`#${String(row.index + 1)}`, row.kind === 'event' ? row.event : row.kind];
  if (row.kind === 'event' && row.id !== undefined) parts.push(`id ${row.id}`);
  parts.push(formatFrameTime(row.at), formatBytes(row.size));

  let body;
  if (row.kind === 'comment') {
    body = <pre className="p-2 font-mono text-xs whitespace-pre-wrap text-fg-default select-text">{row.text}</pre>;
  } else if (row.kind === 'retry') {
    body = (
      <p className="p-2 text-sm text-fg-default">{`The server asked for a reconnect delay of ${String(row.ms)} ms.`}</p>
    );
  } else if (pretty === undefined) {
    body = (
      <p className="p-2 text-sm text-fg-subtle">
        This event’s data was not kept — it went past the record’s payload budget. Its size is kept.
      </p>
    );
  } else {
    body = (
      <div className="flex min-h-0 flex-1 flex-col">
        <label className="flex shrink-0 items-center gap-1 px-2 text-xs text-fg-muted">
          <input
            type="checkbox"
            checked={raw}
            onChange={(event) => {
              setRaw(event.target.checked);
            }}
          />
          Raw
        </label>
        <div className="min-h-0 flex-1">
          <CodeEditor
            ariaLabel="Event data"
            readOnly
            language={raw ? 'text' : pretty.language}
            value={raw ? row.data : pretty.pretty}
          />
        </div>
      </div>
    );
  }

  return (
    <section
      aria-label="Event detail"
      data-testid="sse-event-detail"
      className="flex h-full min-h-0 flex-col border-t border-hairline"
    >
      <p className="shrink-0 px-2 py-1 font-mono text-xs text-fg-subtle">{parts.join(' · ')}</p>
      {body}
    </section>
  );
}
