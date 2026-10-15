import { useEffect, useRef, useState } from 'react';
import type { DragEvent, KeyboardEvent, MouseEvent, ReactNode } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { ChevronDown, ChevronUp, File, FileSymlink, Folder } from 'lucide-react';
import { selectionClass } from '../../../components/selection.js';
import type { SftpEntryWire } from '../../../../shared/sftp-wire.js';
import type { PaneSort, SortColumn } from './files-store.js';
import { formatModified, formatSize, isFolderLike, modeString } from './format.js';

const ROW_HEIGHT = 26;
/**
 * The columns by the list's own width (it is a container): Name is never narrower than 10rem, Modified
 * shows from 560px and Permissions from 440px, so a narrow pane keeps its names rather than scrolling
 * sideways. A hidden cell takes no track, so a row still fills the grid in order.
 */
const GRID =
  'grid grid-cols-[minmax(10rem,1fr)_6rem] @min-[440px]:grid-cols-[minmax(10rem,1fr)_6rem_7rem] @min-[560px]:grid-cols-[minmax(10rem,1fr)_6rem_11rem_7rem] items-center gap-3 px-3';
/** The same without Permissions: this machine's pane, whose permissions are not shown or changed here. */
const GRID_NO_MODE =
  'grid grid-cols-[minmax(10rem,1fr)_6rem] @min-[560px]:grid-cols-[minmax(10rem,1fr)_6rem_11rem] items-center gap-3 px-3';

/** Per column: the classes that show its header button and its cells only from the column's width. */
const SHOWN: Partial<Record<SortColumn, { readonly header: string; readonly cell: string }>> = {
  mtime: { header: 'hidden @min-[560px]:flex', cell: 'hidden @min-[560px]:block' },
  mode: { header: 'hidden @min-[440px]:flex', cell: 'hidden @min-[440px]:block' },
};

const COLUMNS: readonly { readonly column: SortColumn; readonly label: string; readonly end?: boolean }[] = [
  { column: 'name', label: 'Name' },
  { column: 'size', label: 'Size', end: true },
  { column: 'mtime', label: 'Modified' },
  { column: 'mode', label: 'Permissions' },
];

export interface FileListProps {
  /** The folder listed: a new one puts the cursor back at the top. */
  readonly listKey: string;
  /** What to show, already filtered and in order. */
  readonly entries: readonly SftpEntryWire[];
  readonly selected: readonly string[];
  readonly sort: PaneSort;
  readonly onSort: (sort: PaneSort) => void;
  readonly onSelect: (names: readonly string[]) => void;
  /** Enter or a double click: a folder (or a link to one) opens; a host's file is edited in the system editor. */
  readonly onOpen: (entry: SftpEntryWire) => void;
  /** Backspace. */
  readonly onUp: () => void;
  /** Keys the list does not handle itself (F2, Delete, …), with the entry under the cursor; `true` if used. */
  readonly onKey?: (event: KeyboardEvent<HTMLDivElement>, cursor: SftpEntryWire | undefined) => boolean;
  /** A right click on a row: it joins the selection first when it is not in it. */
  readonly onRowContextMenu?: (entry: SftpEntryWire) => void;
  /** Draws a row's name instead of the plain text (renaming in place). */
  readonly renderName?: (entry: SftpEntryWire) => ReactNode | undefined;
  /** Bumped to focus the list (after a rename, or from the other pane). */
  readonly focusRequest?: number;
  /** A row dragged: rows are draggable when this is given. A row not in the selection is selected first. */
  readonly onRowDragStart?: (entry: SftpEntryWire, event: DragEvent<HTMLDivElement>) => void;
  /** Whether this is the pane in use: the other pane's selection shows dimmed. Defaults to true. */
  readonly active?: boolean;
  /** Whether the Permissions column shows; this machine's pane leaves it out. Defaults to true. */
  readonly permissions?: boolean;
}

function EntryIcon({ entry }: { readonly entry: SftpEntryWire }) {
  if (entry.type === 'symlink') {
    return isFolderLike(entry) ? (
      <Folder size={14} aria-hidden="true" className="shrink-0 text-accent" />
    ) : (
      <FileSymlink size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
    );
  }
  return entry.type === 'dir' ? (
    <Folder size={14} aria-hidden="true" className="shrink-0 text-accent" />
  ) : (
    <File size={14} aria-hidden="true" className="shrink-0 text-fg-subtle" />
  );
}

/**
 * A pane's listing: a header to sort by (a second click reverses), and a virtualised window of rows, so a
 * folder of thousands of entries renders only what is on screen. Click, ⇧-click and ⌘-click select; the
 * arrows move, Enter opens, Backspace goes up, ⌘A selects everything.
 */
export function FileList({
  listKey,
  entries,
  selected,
  sort,
  onSort,
  onSelect,
  onOpen,
  onUp,
  onKey,
  onRowContextMenu,
  renderName,
  focusRequest = 0,
  onRowDragStart,
  active = true,
  permissions = true,
}: FileListProps) {
  const grid = permissions ? GRID : GRID_NO_MODE;
  const columns = permissions ? COLUMNS : COLUMNS.filter((c) => c.column !== 'mode');
  const scroller = useRef<HTMLDivElement>(null);
  const [cursor, setCursor] = useState(0);
  /** Where a ⇧ range starts. */
  const anchor = useRef(0);
  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scroller.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 10,
  });
  const chosen = new Set(selected);
  const at = Math.min(cursor, Math.max(entries.length - 1, 0));

  useEffect(() => {
    if (focusRequest > 0) scroller.current?.focus();
  }, [focusRequest]);

  // A new listing starts at the top.
  useEffect(() => {
    setCursor(0);
    anchor.current = 0;
  }, [listKey]);

  const range = (from: number, to: number): string[] =>
    entries.slice(Math.min(from, to), Math.max(from, to) + 1).map((e) => e.name);

  const moveTo = (index: number, extend: boolean): void => {
    const next = Math.max(0, Math.min(entries.length - 1, index));
    const entry = entries[next];
    if (entry === undefined) return;
    setCursor(next);
    virtualizer.scrollToIndex(next);
    if (extend) {
      onSelect(range(anchor.current, next));
    } else {
      anchor.current = next;
      onSelect([entry.name]);
    }
  };

  const onClick = (event: MouseEvent, index: number): void => {
    const entry = entries[index];
    if (entry === undefined) return;
    setCursor(index);
    if (event.shiftKey) {
      onSelect(range(anchor.current, index));
      return;
    }
    anchor.current = index;
    if (event.metaKey || event.ctrlKey) {
      onSelect(chosen.has(entry.name) ? selected.filter((n) => n !== entry.name) : [...selected, entry.name]);
    } else {
      onSelect([entry.name]);
    }
  };

  const onKeyDown = (event: KeyboardEvent<HTMLDivElement>): void => {
    if (onKey?.(event, entries[at]) === true) return;
    const mod = event.metaKey || event.ctrlKey;
    let handled = true;
    if (event.key === 'ArrowDown') moveTo(at + 1, event.shiftKey);
    else if (event.key === 'ArrowUp') moveTo(at - 1, event.shiftKey);
    else if (event.key === 'Home') moveTo(0, event.shiftKey);
    else if (event.key === 'End') moveTo(entries.length - 1, event.shiftKey);
    else if (event.key === 'Enter') {
      const entry = entries[at];
      if (entry !== undefined) onOpen(entry);
    } else if (event.key === 'Backspace') onUp();
    else if (mod && event.key.toLowerCase() === 'a') onSelect(entries.map((e) => e.name));
    else handled = false;
    if (handled) event.preventDefault();
  };

  return (
    <div className="@container flex min-h-0 min-w-0 flex-1 flex-col">
      <div role="row" className={`${grid} h-7 shrink-0 border-b border-hairline text-xs text-fg-subtle`}>
        {columns.map(({ column, label, end }) => {
          const active = sort.column === column;
          const Arrow = sort.descending ? ChevronDown : ChevronUp;
          return (
            <button
              key={column}
              type="button"
              role="columnheader"
              aria-sort={active ? (sort.descending ? 'descending' : 'ascending') : 'none'}
              onClick={() => {
                onSort({ column, descending: active ? !sort.descending : false });
              }}
              className={`${SHOWN[column]?.header ?? 'flex'} items-center gap-1 hover:text-fg-default ${
                end === true ? 'justify-end' : ''
              } ${active ? 'text-fg-default' : ''}`}
            >
              {label}
              {active && <Arrow size={12} aria-hidden="true" />}
            </button>
          );
        })}
      </div>
      <div
        ref={scroller}
        role="listbox"
        aria-label="Files"
        aria-multiselectable="true"
        tabIndex={0}
        data-testid="files-list"
        onKeyDown={onKeyDown}
        className="relative min-h-0 flex-1 overflow-x-hidden overflow-y-auto outline-none focus-visible:ring-1 focus-visible:ring-accent focus-visible:ring-inset"
      >
        {entries.length === 0 && <p className="px-3 py-4 text-sm text-fg-subtle">This folder is empty.</p>}
        <div style={{ height: `${String(virtualizer.getTotalSize())}px` }} className="relative w-full">
          {virtualizer.getVirtualItems().map((item) => {
            const entry = entries[item.index];
            if (entry === undefined) return null;
            const isSelected = chosen.has(entry.name);
            return (
              <div
                key={entry.name}
                role="option"
                aria-selected={isSelected}
                data-testid="files-row"
                data-name={entry.name}
                data-folder={isFolderLike(entry) ? 'true' : undefined}
                data-cursor={item.index === at ? 'true' : undefined}
                draggable={onRowDragStart !== undefined}
                onDragStart={(event) => {
                  onRowDragStart?.(entry, event);
                }}
                onClick={(e) => {
                  onClick(e, item.index);
                }}
                onDoubleClick={() => {
                  onOpen(entry);
                }}
                onContextMenu={() => {
                  setCursor(item.index);
                  onRowContextMenu?.(entry);
                }}
                style={{ height: `${String(ROW_HEIGHT)}px`, transform: `translateY(${String(item.start)}px)` }}
                className={`${grid} absolute top-0 left-0 w-full cursor-default text-sm select-none ${
                  isSelected ? selectionClass(active) : 'text-fg-muted hover:bg-surface-hover'
                } ${item.index === at ? 'outline-1 -outline-offset-1 outline-hairline-strong' : ''}`}
              >
                <span className="flex min-w-0 items-center gap-2">
                  <EntryIcon entry={entry} />
                  {renderName?.(entry) ?? <span className="truncate text-fg-default">{entry.name}</span>}
                </span>
                <span className="text-right tabular-nums">{isFolderLike(entry) ? '—' : formatSize(entry.size)}</span>
                <span className={`${SHOWN.mtime?.cell ?? ''} truncate tabular-nums`}>
                  {formatModified(entry.mtime)}
                </span>
                {permissions && (
                  <span className={`${SHOWN.mode?.cell ?? ''} font-mono text-xs`}>
                    {entry.mode === undefined ? '' : modeString(entry.mode)}
                  </span>
                )}
              </div>
            );
          })}
        </div>
      </div>
    </div>
  );
}
