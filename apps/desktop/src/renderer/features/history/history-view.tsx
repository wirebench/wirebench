import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { MethodBadge } from '../rest-api/method-badge.js';
import { Button } from '../../components/button.js';
import { formatClockTime, formatDuration } from '../../lib/format-size.js';
import type { GridRowProps } from '../../lib/grid-navigation.js';
import { useGridNavigation } from '../../lib/grid-navigation.js';
import { useEditorsStore } from '../../state/editors.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { useHistoryStore } from '../../state/history.js';
import { canResendHistoryEntry, resendHistoryEntry } from './history-actions.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { HistoryEntryWire, WorkspaceProjectWire } from '../../../shared/wire-types.js';

const ROW_HEIGHT = 40;
const VIRTUALISE_ABOVE = 200;

/** Stable empty list: a fresh `[]` from the workspace selector would re-render on every tick. */
const NO_PROJECTS: readonly WorkspaceProjectWire[] = [];

/** The host part of a URL, or the raw string when it doesn't parse (a `${...}` placeholder, say). */
function hostOf(url: string): string {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

type Tone = 'good' | 'bad' | 'neutral';

function toneOf(entry: HistoryEntryWire): Tone {
  if (entry.status === undefined) {
    return 'neutral';
  }
  return entry.ok ? 'good' : 'bad';
}

const TONE_CLASS: Record<Tone, string> = {
  good: 'text-status-success',
  bad: 'text-status-danger',
  neutral: 'text-fg-subtle',
};

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
}

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
}: RowProps) {
  return (
    <div
      role="row"
      aria-rowindex={rowIndex}
      data-testid="history-row"
      {...rowProps}
      className={`flex h-full items-center gap-2 border-b border-hairline px-2 text-xs ${
        compareArmed ? 'bg-surface-selected' : ''
      }`}
    >
      <div role="gridcell" aria-colindex={1} className="flex min-w-0 flex-1">
        <button
          type="button"
          onClick={onOpen}
          className="flex w-full min-w-0 items-center gap-2 text-left hover:underline"
          aria-label={`Open ${entry.requestName}`}
        >
          <span className="w-16 shrink-0 font-mono text-fg-subtle">{formatClockTime(entry.at)}</span>
          {projectName !== undefined && (
            <span className="w-24 shrink-0 truncate text-fg-faint" title={projectName}>
              {projectName}
            </span>
          )}
          {/* A REST row carries its method; a SOAP row its version. Both are the one thing that
              says what kind of send this was, so the column is never empty. */}
          {entry.kind === 'rest' && entry.method !== undefined ? (
            <MethodBadge
              method={entry.method}
              title={`${entry.method} ${entry.requestName}`}
              className="w-12 text-left"
            />
          ) : entry.kind === 'grpc' ? (
            <span data-testid="history-grpc-badge" className="w-12 shrink-0 text-fg-faint">
              gRPC
            </span>
          ) : entry.kind === 'websocket' ? (
            <span data-testid="history-ws-badge" className="w-12 shrink-0 text-fg-faint">
              WS
            </span>
          ) : (
            <span data-testid="history-soap-version" className="w-12 shrink-0 text-fg-faint">
              {entry.soapVersion === 'none' ? 'SOAP' : `SOAP ${entry.soapVersion}`}
            </span>
          )}
          <span className="min-w-0 flex-1 truncate">
            <span className="text-fg-default">{entry.requestName}</span>
            {entry.operationName.length > 0 && <span className="text-fg-subtle"> · {entry.operationName}</span>}
          </span>
          <span className="w-40 shrink-0 truncate text-fg-subtle" title={entry.endpoint}>
            {hostOf(entry.endpoint)}
          </span>
          <span className={`w-10 shrink-0 font-mono ${TONE_CLASS[toneOf(entry)]}`}>{entry.status ?? 'err'}</span>
          <span className="w-16 shrink-0 text-fg-subtle">{formatDuration(entry.durationMs)}</span>
        </button>
      </div>
      <div role="gridcell" aria-colindex={2} className="flex shrink-0 items-center gap-1">
        {/* SOAP, gRPC and REST sends replay from History; a WebSocket session and a REST event
            stream resend from their request. */}
        {canResendHistoryEntry(entry) && (
          <Button variant="ghost" onClick={onResend} title="Re-send" aria-label={`Re-send ${entry.requestName}`}>
            ↻
          </Button>
        )}
        <Button
          variant="ghost"
          onClick={onCompare}
          title="Compare…"
          aria-label={`Compare ${entry.requestName}…`}
          aria-pressed={compareArmed}
        >
          ⇄
        </Button>
        <Button
          variant="ghost"
          onClick={onCompareWithCurrent}
          title="Compare with current"
          aria-label={`Compare ${entry.requestName} with current`}
        >
          ⇄*
        </Button>
      </div>
    </div>
  );
}

/**
 * The activity bar's History view: search, a virtualised list of every recorded send, and
 * per-row Open/Re-send/Compare actions.
 */
export function HistoryView() {
  const entries = useHistoryStore((state) => state.entries);
  const total = useHistoryStore((state) => state.total);
  const query = useHistoryStore((state) => state.query);
  const search = useHistoryStore((state) => state.search);
  const clear = useHistoryStore((state) => state.clear);
  const projectFilter = useHistoryStore((state) => state.projectId);
  const setProjectFilter = useHistoryStore((state) => state.setProjectFilter);
  const workspaceProjects = useWorkspaceStore((state) => state.workspace?.projects ?? NO_PROJECTS);
  const projectNameOf = (projectId: string): string | undefined =>
    workspaceProjects.find((project) => project.id === projectId)?.name;
  const openTab = useEditorsStore((state) => state.open);
  const openOrReplaceTab = useEditorsStore((state) => state.openOrReplace);
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
    openTab({ id: `history:${entry.id}`, kind: 'history', title: entry.requestName, historyId: entry.id });
  };

  const resend = (entry: HistoryEntryWire) => {
    void resendHistoryEntry(entry);
  };

  const openDiff = (a: HistoryEntryWire, b: HistoryEntryWire) => {
    openOrReplaceTab({
      id: 'diff',
      kind: 'diff',
      title: 'Compare',
      diff: {
        leftLabel: `${a.requestName} (${formatClockTime(a.at)})`,
        rightLabel: `${b.requestName} (${formatClockTime(b.at)})`,
        leftXml: a.response?.envelopeXml ?? a.request.envelopeXml,
        rightXml: b.response?.envelopeXml ?? b.request.envelopeXml,
      },
    });
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

  const compareWithCurrent = (entry: HistoryEntryWire) => {
    const current =
      entry.requestId !== undefined ? useExchangesStore.getState().byRequest[entry.requestId]?.exchange : undefined;
    if (current === undefined) {
      return;
    }
    openOrReplaceTab({
      id: 'diff',
      kind: 'diff',
      title: 'Compare',
      diff: {
        leftLabel: `${entry.requestName} (${formatClockTime(entry.at)})`,
        rightLabel: 'Current',
        leftXml: entry.response?.envelopeXml ?? entry.request.envelopeXml,
        rightXml: current.response?.envelopeXml ?? '',
      },
    });
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
          // a row is opened, re-sent or compared, never "selected" — so no row carries
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
                />
              </div>
            ))
          )}
        </div>
      )}
      <p className="shrink-0 border-t border-hairline px-2 py-1 text-xs text-fg-faint">{total} entries</p>
    </div>
  );
}
