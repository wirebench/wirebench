import { useRef, useState } from 'react';
import * as DropdownMenu from '@radix-ui/react-dropdown-menu';
import { MoreHorizontal } from 'lucide-react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { rendererKindOf } from '../../kinds/index.js';
import { Button } from '../../components/button.js';
import { formatClockTime, formatDuration } from '../../lib/format-size.js';
import type { GridRowProps } from '../../lib/grid-navigation.js';
import { useGridNavigation } from '../../lib/grid-navigation.js';
import { previewing, useEditorsStore } from '../../state/editors.js';
import { useHistoryStore } from '../../state/history.js';
import { canResendHistoryEntry, entrySide, openCompareTab, resendHistoryEntry } from './history-actions.js';
import { endpointParts, historyCountLabel, historyStatusChip, historyTabTitle, hostOf } from './history-row-text.js';
import { compareBannerText, compareStep } from './history-compare.js';
import { requestDisplayName } from '../rest-api/request-display-name.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { HistoryEntryWire } from '@shared/wire-types.js';
import type { WorkspaceProjectWire } from '@shared/wire-base.js';

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

const ITEM_CLASS =
  'flex cursor-pointer items-center rounded px-2 py-1.5 text-sm text-fg-default outline-none data-[disabled]:cursor-not-allowed data-[disabled]:opacity-50 data-[highlighted]:bg-accent-muted';
const CONTENT_CLASS = 'z-50 min-w-44 rounded-md border border-hairline bg-surface-raised p-1 shadow-lg';

interface RowProps {
  readonly entry: HistoryEntryWire;
  /** The entry's project name, when it's known and worth showing (several projects open). */
  readonly projectName: string | undefined;
  /** 1-based position in the full (unvirtualised) list, for `aria-rowindex`. */
  readonly rowIndex: number;
  /** Roving-tabindex props from {@link useGridNavigation}. */
  readonly rowProps: GridRowProps;
  readonly compareArmed: boolean;
  /** A click: opens the entry as the preview tab. */
  readonly onOpen: () => void;
  /** A double-click or Enter: opens the entry as a tab of its own. */
  readonly onPin: () => void;
  readonly onResend: () => void;
  readonly onCompare: () => void;
  readonly onCompareWithCurrent: () => void;
  readonly onDelete: () => void;
}

/**
 * One recorded send, on two lines. A send with an HTTP method leads with it and the path, the host
 * faint beside them, so sends to `/pets` and `/pets/1` tell apart (G04); the second line says when,
 * which request and how long. A send without one (SOAP) leads with its request and operation, and
 * the host sits on the second line. A click anywhere on it opens the entry. Its actions are behind
 * one 24px ⋯ button at the far right, so however narrow the sidebar, a click on the row never
 * re-sends, compares or deletes: each of those is a menu choice.
 */
function Row({
  entry,
  projectName,
  rowIndex,
  rowProps,
  compareArmed,
  onOpen,
  onPin,
  onResend,
  onCompare,
  onCompareWithCurrent,
  onDelete,
}: RowProps) {
  const Badge = rendererKindOf(entry.kind)?.history.Badge;
  const name = requestDisplayName(entry.requestName, entry.method);
  const byPath = entry.method !== undefined && entry.method.length > 0;
  const { path, host } = endpointParts(entry.endpoint);
  const details = byPath
    ? [formatClockTime(entry.at), name, projectName, formatDuration(entry.durationMs)]
    : [formatClockTime(entry.at), projectName, hostOf(entry.endpoint), formatDuration(entry.durationMs)];
  // A right-click opens the same menu as ⋯, so the row's actions are where a right-click looks first.
  const [menuOpen, setMenuOpen] = useState(false);
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-testid="history-row"
      {...rowProps}
      onKeyDown={(event) => {
        // Enter on the row itself; the focused ⋯ button handles its own Enter.
        if (event.key === 'Enter' && event.target === event.currentTarget) {
          event.preventDefault();
          onPin();
        }
      }}
      onContextMenu={(event) => {
        event.preventDefault();
        setMenuOpen(true);
      }}
      data-compare-armed={compareArmed ? 'true' : undefined}
      className={`flex h-full items-stretch border-b border-hairline text-xs ${
        compareArmed ? 'bg-accent-muted shadow-[inset_2px_0_0_var(--color-accent)]' : 'hover:bg-surface-hover'
      }`}
    >
      <div role="gridcell" aria-colindex={1} className="flex min-w-0 flex-1">
        {/* Out of the tab order: the row is the tab stop, and Enter on it opens. */}
        <button
          type="button"
          tabIndex={-1}
          onClick={onOpen}
          onDoubleClick={onPin}
          className="flex w-full min-w-0 flex-col justify-center gap-0.5 px-2 text-left"
          aria-label={`Open ${name}`}
        >
          <span className="flex w-full min-w-0 items-center gap-2">
            {/* A REST row carries its method; a SOAP row its version. Both are the one thing that
                says what kind of send this was, so the badge is never empty. */}
            {Badge !== undefined && <Badge entry={entry} place="row" />}
            {byPath ? (
              <span className="min-w-0 flex-1 truncate" title={entry.endpoint}>
                <span data-testid="history-row-path" className="font-mono text-fg-default">
                  {path}
                </span>
                {host.length > 0 && (
                  <span data-testid="history-row-host" className="text-fg-faint">
                    {' '}
                    {host}
                  </span>
                )}
              </span>
            ) : (
              <span className="min-w-0 flex-1 truncate">
                <span className="text-fg-default">{name}</span>
                {entry.operationName.length > 0 && <span className="text-fg-subtle"> · {entry.operationName}</span>}
              </span>
            )}
            <span
              data-testid="history-status-chip"
              title={entry.error?.message}
              className={`shrink-0 rounded-sm px-1 font-mono ${TONE_CLASS[toneOf(entry)]}`}
            >
              {historyStatusChip(entry)}
            </span>
          </span>
          <span className="w-full truncate text-fg-subtle" title={entry.endpoint}>
            {details.filter((part) => part !== undefined).join(' · ')}
          </span>
        </button>
      </div>
      <div role="gridcell" aria-colindex={2} className="flex shrink-0 items-center pr-1">
        <DropdownMenu.Root open={menuOpen} onOpenChange={setMenuOpen}>
          <DropdownMenu.Trigger asChild>
            <button
              type="button"
              data-testid="history-row-actions"
              aria-label={`Actions for ${name}`}
              title="Actions"
              className="inline-flex size-6 items-center justify-center rounded text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
            >
              <MoreHorizontal size={14} aria-hidden="true" />
            </button>
          </DropdownMenu.Trigger>
          <DropdownMenu.Portal>
            <DropdownMenu.Content align="end" className={CONTENT_CLASS}>
              {/* SOAP, gRPC and REST sends replay from History; a WebSocket session and a REST
                  event stream resend from their request. */}
              {canResendHistoryEntry(entry) && (
                <DropdownMenu.Item className={ITEM_CLASS} onSelect={onResend}>
                  Re-send
                </DropdownMenu.Item>
              )}
              <DropdownMenu.Item className={ITEM_CLASS} onSelect={onCompare}>
                {compareArmed ? 'Cancel compare' : 'Compare…'}
              </DropdownMenu.Item>
              <DropdownMenu.Item className={ITEM_CLASS} onSelect={onCompareWithCurrent}>
                Compare with current
              </DropdownMenu.Item>
              <DropdownMenu.Separator className="my-1 h-px bg-hairline" />
              <DropdownMenu.Item className={ITEM_CLASS} onSelect={onDelete}>
                Delete
              </DropdownMenu.Item>
            </DropdownMenu.Content>
          </DropdownMenu.Portal>
        </DropdownMenu.Root>
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

  // A click browses: the entry opens as the preview tab, which the next click replaces (G04, #679).
  const previewEntry = (entry: HistoryEntryWire) => {
    previewing(() => openEntry(entry));
  };

  const resend = (entry: HistoryEntryWire) => {
    void resendHistoryEntry(entry);
  };

  const openDiff = (a: HistoryEntryWire, b: HistoryEntryWire) => {
    openCompareTab(entrySide(a), entrySide(b));
  };

  // The first side, while it is still listed: a search or a delete that drops it ends the compare.
  const compareEntry =
    compareFirst === undefined ? undefined : entries.find((candidate) => candidate.id === compareFirst);
  const armed = compareEntry?.id;

  const compare = (entry: HistoryEntryWire) => {
    const step = compareStep(armed, entry.id);
    if (step.kind === 'arm') {
      setCompareFirst(step.first);
      return;
    }
    setCompareFirst(undefined);
    if (step.kind === 'compare' && compareEntry !== undefined) {
      openDiff(compareEntry, entry);
    }
  };

  // While a first side is picked, a click on another row picks the second, as the banner says.
  const openOrPick = (entry: HistoryEntryWire, open: (entry: HistoryEntryWire) => void) => {
    if (armed !== undefined && armed !== entry.id) {
      compare(entry);
      return;
    }
    open(entry);
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
      {/* Search on a row of its own, so a narrow sidebar never squeezes it; the filter and Delete
          all share the row below. */}
      <div className="flex shrink-0 flex-col gap-1.5 border-b border-hairline px-2 py-2">
        <input
          type="search"
          aria-label="Search history"
          placeholder="Search history…"
          value={query}
          onChange={(event) => search(event.target.value)}
          className="h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default"
        />
        <div className="flex min-w-0 items-center gap-2">
          {/* With one project open there is nothing to filter by. */}
          {workspaceProjects.length > 1 && (
            <select
              aria-label="Filter history by project"
              data-testid="history-project-filter"
              value={projectFilter ?? ''}
              onChange={(event) => {
                setProjectFilter(event.target.value.length > 0 ? event.target.value : undefined);
              }}
              className="h-row min-w-0 flex-1 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default"
            >
              <option value="">All projects</option>
              {workspaceProjects.map((project) => (
                <option key={project.id} value={project.id}>
                  {project.name}
                </option>
              ))}
            </select>
          )}
          <div className="ml-auto flex shrink-0 items-center gap-2">
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
        </div>
      </div>

      {compareEntry !== undefined && (
        <div
          role="status"
          data-testid="history-compare-banner"
          className="flex shrink-0 items-center gap-2 border-b border-hairline bg-accent-muted px-2 py-1.5 text-xs text-fg-default"
        >
          <span className="min-w-0 flex-1 truncate">
            {compareBannerText(compareEntry)}
            <span className="text-fg-subtle"> — pick another entry</span>
          </span>
          <Button variant="ghost" onClick={() => setCompareFirst(undefined)}>
            Cancel
          </Button>
        </div>
      )}

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
                      compareArmed={armed === entry.id}
                      onOpen={() => openOrPick(entry, previewEntry)}
                      onPin={() => openOrPick(entry, openEntry)}
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
                  compareArmed={armed === entry.id}
                  onOpen={() => openOrPick(entry, previewEntry)}
                  onPin={() => openOrPick(entry, openEntry)}
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
