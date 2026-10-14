import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { rendererKindOf } from '../../kinds/index.js';
import { Button } from '../../components/button.js';
import { formatClockTime, formatDuration } from '../../lib/format-size.js';
import type { GridRowProps } from '../../lib/grid-navigation.js';
import { useGridNavigation } from '../../lib/grid-navigation.js';
import { useEditorsStore } from '../../state/editors.js';
import { useHistoryStore } from '../../state/history.js';
import { canResendHistoryEntry, entrySide, openCompareTab, resendHistoryEntry } from './history-actions.js';
import { historyCountLabel, historyTabTitle, hostOf } from './history-row-text.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';
import type { WorkspaceProjectWire } from '../../../shared/wire-base.js';

// Two lines of `text-xs` plus the row's padding.
const ROW_HEIGHT = 44;
const VIRTUALISE_ABOVE = 200;

/** Stable empty list: a fresh `[]` from the workspace selector would re-render on every tick. */
const NO_PROJECTS: readonly WorkspaceProjectWire[] = [];

type Tone = 'good' | 'bad' | 'neutral';

function toneOf(entry: HistoryEntryWire): Tone {
  if (entry.status === undefined) {
    return 'neutral';
  }
  return entry.ok ? 'good' : 'bad';
}

const TONE_CLASS: Record<Tone, string> = {
  good: 'bg-status-success/15 text-status-success',
  bad: 'bg-status-danger/15 text-status-danger',
  neutral: 'bg-surface-hover text-fg-subtle',
};

const ACTION_CLASS = 'px-1.5';

interface RowProps {
  readonly entry: HistoryEntryWire;
  /** The entry's project name, when it's known and worth showing (several projects open). */
  readonly projectName: string | undefined;
  /** 1-based position in the full (unvirtualised) list, for `aria-rowindex`. */
  readonly rowIndex: number;
  /** Roving-tabindex props from {@link useGridNavigation}. */
  readonly rowProps: GridRowProps;
  readonly compareArmed: boolean;
  readonly onOpen: () => void;
  readonly onResend: () => void;
  readonly onCompare: () => void;
  readonly onCompareWithCurrent: () => void;
  readonly onDelete: () => void;
}

/**
 * One recorded send, on two lines: what it was (kind badge, name, status) and when and where it
 * went (time · host · duration). A click anywhere on it opens the entry; the actions sit in an
 * overlay at the right edge that shows on hover or focus, so a click aimed at the row's text
 * never lands on Re-send.
 */
function Row({
  entry,
  projectName,
  rowIndex,
  rowProps,
  compareArmed,
  onOpen,
  onResend,
  onCompare,
  onCompareWithCurrent,
  onDelete,
}: RowProps) {
  const Badge = rendererKindOf(entry.kind)?.history.Badge;
  const details = [formatClockTime(entry.at), projectName, hostOf(entry.endpoint), formatDuration(entry.durationMs)];
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-testid="history-row"
      {...rowProps}
      onKeyDown={(event) => {
        // Enter on the row itself; a focused action button handles its own Enter.
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault();
          onOpen();
        }
      }}
      className={`group relative flex h-full items-stretch border-b border-hairline text-xs ${
        compareArmed ? 'bg-surface-selected' : 'hover:bg-surface-hover'
      }`}
    >
      <div role="gridcell" aria-colindex={1} className="flex min-w-0 flex-1">
        {/* Out of the tab order: the row is the tab stop, and Enter on it opens. */}
        <button
          type="button"
          tabIndex={-1}
          onClick={onOpen}
          className="flex w-full min-w-0 flex-col justify-center gap-0.5 px-2 text-left"
          aria-label={`Open ${entry.requestName}`}
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            {/* A REST row carries its method; a SOAP row its version. Both are the one thing that
                says what kind of send this was, so the badge is never empty. */}
            {Badge !== undefined && <Badge entry={entry} place="row" />}
            <span className="min-w-0 flex-1 truncate">
              <span className="text-fg-default">{entry.requestName}</span>
              {entry.operationName.length > 0 && <span className="text-fg-subtle"> · {entry.operationName}</span>}
            </span>
            <span className={`shrink-0 rounded-sm px-1 font-mono ${TONE_CLASS[toneOf(entry)]}`}>
              {entry.status ?? 'err'}
            </span>
          </span>
          <span className="w-full truncate text-fg-subtle" title={entry.endpoint}>
            {details.filter((part) => part !== undefined).join(' · ')}
          </span>
        </button>
      </div>
      <div
        role="gridcell"
        aria-colindex={2}
        data-testid="history-row-actions"
        className={`absolute inset-y-0 right-0 flex items-center gap-0.5 bg-surface-raised px-1 shadow-sm ${
          compareArmed ? 'opacity-100' : 'opacity-0 group-focus-within:opacity-100 group-hover:opacity-100'
        }`}
      >
        {/* SOAP, gRPC and REST sends replay from History; a WebSocket session and a REST event
            stream resend from their request. */}
        {canResendHistoryEntry(entry) && (
          <Button
            variant="ghost"
            className={ACTION_CLASS}
            onClick={onResend}
            title="Re-send"
            aria-label={`Re-send ${entry.requestName}`}
          >
            ↻
          </Button>
        )}
        <Button
          variant="ghost"
          className={ACTION_CLASS}
          onClick={onCompare}
          title="Compare…"
          aria-label={`Compare ${entry.requestName}…`}
          aria-pressed={compareArmed}
        >
          ⇄
        </Button>
        <Button
          variant="ghost"
          className={ACTION_CLASS}
          onClick={onCompareWithCurrent}
          title="Compare with current"
          aria-label={`Compare ${entry.requestName} with current`}
        >
          ⇄*
        </Button>
        <Button
          variant="ghost"
          className={ACTION_CLASS}
          onClick={onDelete}
          title="Delete"
          aria-label={`Delete ${entry.requestName}`}
        >
          ✕
        </Button>
      </div>
    </div>
  );
}

/**
 * The activity bar's History view: search, a virtualised list of every recorded send, and
 * per-row Open/Re-send/Compare/Delete actions.
 */
export function HistoryView() {
  const entries = useHistoryStore((state) => state.entries);
  const total = useHistoryStore((state) => state.total);
  const query = useHistoryStore((state) => state.query);
  const search = useHistoryStore((state) => state.search);
  const clear = useHistoryStore((state) => state.clear);
  const remove = useHistoryStore((state) => state.remove);
  const projectFilter = useHistoryStore((state) => state.projectId);
  const setProjectFilter = useHistoryStore((state) => state.setProjectFilter);
  const workspaceProjects = useWorkspaceStore((state) => state.workspace?.projects ?? NO_PROJECTS);
  const projectNameOf = (projectId: string): string | undefined =>
    workspaceProjects.find((project) => project.id === projectId)?.name;
  const openTab = useEditorsStore((state) => state.open);
  const [compareFirst, setCompareFirst] = useState<string | undefined>(undefined);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);
  const { gridProps, rowProps } = useGridNavigation(entries.length);

  const virtualised = entries.length > VIRTUALISE_ABOVE;
  const virtualizer = useVirtualizer({
    count: virtualised ? entries.length : 0,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => ROW_HEIGHT,
    overscan: 12,
  });

  const openEntry = (entry: HistoryEntryWire) => {
    openTab({ id: `history:${entry.id}`, kind: 'history', title: historyTabTitle(entry), historyId: entry.id });
  };

  const resend = (entry: HistoryEntryWire) => {
    void resendHistoryEntry(entry);
  };

  const openDiff = (a: HistoryEntryWire, b: HistoryEntryWire) => {
    openCompareTab(entrySide(a), entrySide(b));
  };

  const compare = (entry: HistoryEntryWire) => {
    if (compareFirst === undefined) {
      setCompareFirst(entry.id);
      return;
    }
    if (compareFirst === entry.id) {
      setCompareFirst(undefined);
      return;
    }
    const first = entries.find((candidate) => candidate.id === compareFirst);
    setCompareFirst(undefined);
    if (first !== undefined) {
      openDiff(first, entry);
    }
  };

  // Compares with the request's latest response: a REST request's from its own exchange map, since
  // the SOAP map never holds one.
  const compareWithCurrent = (entry: HistoryEntryWire) => {
    if (entry.requestId === undefined) {
      return;
    }
    const current = rendererKindOf(entry.kind)?.history.current?.(entry.requestId);
    if (current !== undefined) {
      openCompareTab(entrySide(entry), current);
    }
  };

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex shrink-0 items-center gap-2 border-b border-hairline px-2 py-2">
        <input
          type="search"
          aria-label="Search history"
          placeholder="Search history…"
          value={query}
          onChange={(event) => search(event.target.value)}
          className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default"
        />
        <select
          aria-label="Filter history by project"
          data-testid="history-project-filter"
          value={projectFilter ?? ''}
          onChange={(event) => {
            setProjectFilter(event.target.value.length > 0 ? event.target.value : undefined);
          }}
          className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default"
        >
          <option value="">All projects</option>
          {workspaceProjects.map((project) => (
            <option key={project.id} value={project.id}>
              {project.name}
            </option>
          ))}
        </select>
        {confirmingClear ? (
          <>
            <Button
              variant="secondary"
              onClick={() => {
                setConfirmingClear(false);
                void clear();
              }}
            >
              Confirm
            </Button>
            <Button variant="ghost" onClick={() => setConfirmingClear(false)}>
              Cancel
            </Button>
          </>
        ) : (
          <Button variant="ghost" onClick={() => setConfirmingClear(true)} disabled={total === 0}>
            Delete all
          </Button>
        )}
      </div>

      {entries.length === 0 ? (
        <p className="p-3 text-sm text-fg-subtle">
          {query.length > 0 ? 'No history entries match your search.' : 'Sent requests appear here.'}
        </p>
      ) : (
        <div
          ref={scrollRef}
          role="grid"
          aria-label="History"
          aria-rowcount={entries.length}
          // Two columns: the entry itself and its actions. There is no selection model here —
          // a row is opened, re-sent, compared or deleted, never "selected" — so no row carries
          // `aria-selected`, and the roving tab stop is focus only.
          aria-colcount={2}
          className="min-h-0 flex-1 overflow-auto"
          {...gridProps}
        >
          {virtualised ? (
            <div role="presentation" style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = entries[item.index];
                return entry === undefined ? null : (
                  <div
                    key={entry.id}
                    // The virtualiser's positioning wrapper is a layout box only: without this
                    // it would sit between `role="grid"` and `role="row"` and break the
                    // required-parent relationship.
                    role="presentation"
                    style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: item.size }}
                  >
                    <Row
                      entry={entry}
                      projectName={projectNameOf(entry.projectId)}
                      rowIndex={item.index + 1}
                      rowProps={rowProps(item.index)}
                      compareArmed={compareFirst === entry.id}
                      onOpen={() => openEntry(entry)}
                      onResend={() => resend(entry)}
                      onCompare={() => compare(entry)}
                      onCompareWithCurrent={() => compareWithCurrent(entry)}
                      onDelete={() => void remove(entry.id)}
                    />
                  </div>
                );
              })}
            </div>
          ) : (
            entries.map((entry, index) => (
              <div key={entry.id} role="presentation" style={{ height: ROW_HEIGHT }}>
                <Row
                  entry={entry}
                  projectName={projectNameOf(entry.projectId)}
                  rowIndex={index + 1}
                  rowProps={rowProps(index)}
                  compareArmed={compareFirst === entry.id}
                  onOpen={() => openEntry(entry)}
                  onResend={() => resend(entry)}
                  onCompare={() => compare(entry)}
                  onCompareWithCurrent={() => compareWithCurrent(entry)}
                  onDelete={() => void remove(entry.id)}
                />
              </div>
            ))
          )}
        </div>
      )}
      <p className="shrink-0 border-t border-hairline px-2 py-1 text-xs text-fg-faint">{historyCountLabel(total)}</p>
    </div>
  );
}
