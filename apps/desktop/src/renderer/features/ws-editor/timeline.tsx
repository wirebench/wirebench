/**
 * The WebSocket timeline: one row per frame, sent and received interleaved in the order they
 * happened.
 *
 * A sibling of the gRPC pane's `MessagesView`, on the same two rules: rows are keyed by the frame's
 * own `index`, so a new frame adds one row instead of rebuilding the list, and the scroll follows
 * the newest row only while the reader is already at the bottom — scrolling up to read a frame pins
 * the view there. That component keeps its pinning inline rather than exporting a hook, so the same
 * rule is written again here as {@link useFollowBottom} rather than changing it.
 *
 * A session can run for hours. Past {@link WS_TIMELINE_WINDOW} rows the list paints only the rows
 * in view (and a margin either side) between two spacers of the right height, so a long session
 * scrolls like a short one.
 */
import { memo, useLayoutEffect, useMemo, useRef, useState, type KeyboardEvent, type RefObject } from 'react';
import { ArrowDown, ArrowUp } from 'lucide-react';
import { formatBytes } from '../../lib/format-size.js';
import type { WsFrameWire } from '../../../shared/wire-types.js';
import { formatFrameTime, framePreview, isControlFrame } from './ws-format.js';

/** Past this many rows the timeline renders a window rather than every row. */
export const WS_TIMELINE_WINDOW = 1000;

/** Every row is the same height, which is what lets the window be computed from `scrollTop`. */
const ROW_HEIGHT = 24;
/** Rows painted above and below the viewport while windowed. */
const OVERSCAN = 20;
/** The viewport height in rows when layout has not measured one (a hidden pane, a test). */
const FALLBACK_VIEWPORT_ROWS = 40;
/** How close to the bottom still counts as "at the bottom". */
const PIN_SLACK_PX = 24;

type Direction = 'all' | 'sent' | 'received';

/**
 * Each frame's lower-cased preview, computed once per frame object: the store keeps a frame's
 * identity once it has arrived, so a keystroke in the filter re-reads thousands of cached strings
 * rather than re-deriving (and for binary, re-hexing) each one.
 */
const searchText = new WeakMap<WsFrameWire, string>();

function searchTextOf(frame: WsFrameWire): string {
  let text = searchText.get(frame);
  if (text === undefined) {
    text = framePreview(frame).toLowerCase();
    searchText.set(frame, text);
  }
  return text;
}

const DIRECTIONS: readonly { readonly id: Direction; readonly label: string }[] = [
  { id: 'all', label: 'All' },
  { id: 'sent', label: 'Sent' },
  { id: 'received', label: 'Received' },
];

/**
 * Keeps a scroller at its bottom as `count` grows, but only while it was at the bottom already.
 * Answers whether it is pinned (for the window) and the scroll handler to attach.
 */
export function useFollowBottom(
  scroller: RefObject<HTMLElement | null>,
  count: number,
): { readonly pinned: boolean; readonly scrollTop: number; readonly onScroll: () => void } {
  const pinnedRef = useRef(true);
  const [position, setPosition] = useState({ pinned: true, scrollTop: 0 });

  useLayoutEffect(() => {
    const element = scroller.current;
    if (element === null || !pinnedRef.current) {
      return;
    }
    element.scrollTop = element.scrollHeight;
  }, [scroller, count]);

  const onScroll = (): void => {
    const element = scroller.current;
    if (element === null) return;
    const pinned = element.scrollHeight - element.scrollTop - element.clientHeight < PIN_SLACK_PX;
    pinnedRef.current = pinned;
    setPosition({ pinned, scrollTop: element.scrollTop });
  };

  return { pinned: position.pinned, scrollTop: position.scrollTop, onScroll };
}

export interface WsTimelineProps {
  readonly frames: readonly WsFrameWire[];
  /** The `index` of the selected frame, if any. */
  readonly selectedIndex?: number | undefined;
  readonly onSelect?: ((index: number) => void) | undefined;
  /** How many of the oldest frames were let go from memory during a long session. */
  readonly droppedFrames?: number | undefined;
}

/** The timeline: filters on top, then the rows. */
export function WsTimeline({ frames, selectedIndex, onSelect, droppedFrames }: WsTimelineProps) {
  const [direction, setDirection] = useState<Direction>('all');
  const [showControl, setShowControl] = useState(true);
  const [query, setQuery] = useState('');
  const scroller = useRef<HTMLDivElement | null>(null);

  // The session's real frame count, not the count still held: past the live cap the oldest frames
  // are let go, and a total that shrank back to the cap would disagree with the status line's
  // running counts, which never forget one.
  const total = frames.length + (droppedFrames ?? 0);

  const visible = useMemo(() => {
    const needle = query.trim().toLowerCase();
    return frames.filter(
      (frame) =>
        (direction === 'all' || frame.direction === direction) &&
        (showControl || !isControlFrame(frame)) &&
        (needle === '' || searchTextOf(frame).includes(needle)),
    );
  }, [frames, direction, showControl, query]);

  const { pinned, scrollTop, onScroll } = useFollowBottom(scroller, visible.length);

  const windowed = visible.length > WS_TIMELINE_WINDOW;
  let start = 0;
  let end = visible.length;
  if (windowed) {
    const measured = scroller.current?.clientHeight ?? 0;
    const viewportRows = measured > 0 ? Math.ceil(measured / ROW_HEIGHT) : FALLBACK_VIEWPORT_ROWS;
    const span = viewportRows + OVERSCAN * 2;
    start = pinned
      ? Math.max(0, visible.length - span)
      : Math.min(Math.max(0, Math.floor(scrollTop / ROW_HEIGHT) - OVERSCAN), Math.max(0, visible.length - span));
    end = Math.min(visible.length, start + span);
  }
  const shown = visible.slice(start, end);

  const move = (event: KeyboardEvent<HTMLUListElement>): void => {
    if (onSelect === undefined || visible.length === 0) return;
    if (event.key !== 'ArrowDown' && event.key !== 'ArrowUp') return;
    event.preventDefault();
    const at = visible.findIndex((frame) => frame.index === selectedIndex);
    const next =
      at === -1
        ? event.key === 'ArrowDown'
          ? 0
          : visible.length - 1
        : Math.min(visible.length - 1, Math.max(0, at + (event.key === 'ArrowDown' ? 1 : -1)));
    onSelect(visible[next]!.index);
  };

  return (
    <div data-testid="ws-timeline" className="flex min-h-0 flex-1 flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-3 border-b border-hairline px-2 py-1 text-xs">
        <fieldset className="flex items-center gap-2">
          <legend className="sr-only">Direction</legend>
          {DIRECTIONS.map((option) => (
            <label key={option.id} className="flex items-center gap-1 text-fg-muted">
              <input
                type="radio"
                name="ws-timeline-direction"
                checked={direction === option.id}
                onChange={() => {
                  setDirection(option.id);
                }}
              />
              {option.label}
            </label>
          ))}
        </fieldset>
        <label className="flex items-center gap-1 text-fg-muted">
          <input
            type="checkbox"
            checked={showControl}
            onChange={(event) => {
              setShowControl(event.target.checked);
            }}
          />
          Control frames
        </label>
        <input
          type="search"
          aria-label="Filter frames"
          placeholder="Filter"
          value={query}
          onChange={(event) => {
            setQuery(event.target.value);
          }}
          className="h-6 min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default focus:ring-1 focus:ring-accent focus:outline-none"
        />
        <span data-testid="ws-timeline-count" className="shrink-0 text-fg-subtle">
          {visible.length === frames.length
            ? `${String(total)} frame${total === 1 ? '' : 's'}`
            : `${String(visible.length)} of ${String(total)} frames`}
        </span>
      </div>
      {droppedFrames !== undefined && droppedFrames > 0 && (
        <p data-testid="ws-timeline-dropped" className="shrink-0 px-2 py-1 text-xs text-status-warning">
          {`${String(droppedFrames)} earlier frames were let go to keep this long session light.`}
        </p>
      )}
      <div
        ref={scroller}
        data-testid="ws-timeline-scroller"
        onScroll={onScroll}
        className="min-h-0 flex-1 overflow-auto"
      >
        {frames.length === 0 ? (
          <p className="p-2 text-sm text-fg-subtle">No frames yet.</p>
        ) : (
          <ul
            role="listbox"
            aria-label="Frames"
            tabIndex={0}
            onKeyDown={move}
            className="font-mono text-xs focus:outline-none focus-visible:ring-1 focus-visible:ring-accent"
          >
            {start > 0 && <li aria-hidden="true" style={{ height: start * ROW_HEIGHT }} />}
            {shown.map((frame) => (
              <TimelineRow
                key={frame.index}
                frame={frame}
                selected={frame.index === selectedIndex}
                onSelect={onSelect}
              />
            ))}
            {end < visible.length && <li aria-hidden="true" style={{ height: (visible.length - end) * ROW_HEIGHT }} />}
          </ul>
        )}
      </div>
    </div>
  );
}

/** Memoised: a new frame, or a selection change, repaints only the rows it touches. */
const TimelineRow = memo(function TimelineRow({
  frame,
  selected,
  onSelect,
}: {
  readonly frame: WsFrameWire;
  readonly selected: boolean;
  readonly onSelect?: ((index: number) => void) | undefined;
}) {
  const sent = frame.direction === 'sent';
  return (
    <li
      role="option"
      aria-selected={selected}
      data-testid="ws-frame-row"
      onClick={() => {
        onSelect?.(frame.index);
      }}
      style={{ height: ROW_HEIGHT }}
      className={`flex cursor-default items-center gap-2 px-2 ${
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
      <span className="w-20 shrink-0 text-fg-subtle">{formatFrameTime(frame.at)}</span>
      {frame.opcode !== 'text' && (
        <span
          data-testid="ws-frame-opcode"
          className="shrink-0 rounded-sm border border-hairline-strong px-1 text-2xs text-fg-subtle"
        >
          {frame.opcode}
        </span>
      )}
      <span className="w-16 shrink-0 text-right text-fg-subtle">{formatBytes(frame.size)}</span>
      <span className="min-w-0 flex-1 truncate text-fg-default">{framePreview(frame)}</span>
    </li>
  );
});
