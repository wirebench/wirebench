import { useRef, useState } from 'react';
import { useVirtualizer } from '@tanstack/react-virtual';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { formatClockTime } from '../../lib/format-size.js';
import { useEditorsStore } from '../../state/editors.js';
import { useExchangesStore } from '../../state/exchanges.js';
import { useHistoryStore } from '../../state/history.js';
import { ipc } from '../../state/ipc-client.js';
import type { HistoryEntryWire } from '../../../shared/wire-types.js';

const ROW_HEIGHT = 40;
const VIRTUALISE_ABOVE = 200;

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
  readonly compareArmed: boolean;
  readonly onOpen: () => void;
  readonly onResend: () => void;
  readonly onCompare: () => void;
  readonly onCompareWithCurrent: () => void;
}

function Row({ entry, compareArmed, onOpen, onResend, onCompare, onCompareWithCurrent }: RowProps) {
  return (
    <div
      data-testid="history-row"
      className={`flex h-full items-center gap-2 border-b border-hairline px-2 text-xs ${
        compareArmed ? 'bg-surface-selected' : ''
      }`}
    >
      <button
        type="button"
        onClick={onOpen}
        className="flex min-w-0 flex-1 items-center gap-2 text-left hover:underline"
        aria-label={`Open ${entry.requestName}`}
      >
        <span className="w-16 shrink-0 font-mono text-fg-subtle">{formatClockTime(entry.at)}</span>
        <span className="min-w-0 flex-1 truncate">
          <span className="text-fg-default">{entry.requestName}</span>
          {entry.operationName.length > 0 && <span className="text-fg-subtle"> · {entry.operationName}</span>}
        </span>
        <span className="w-40 shrink-0 truncate text-fg-subtle" title={entry.endpoint}>
          {hostOf(entry.endpoint)}
        </span>
        <span className={`w-10 shrink-0 font-mono ${TONE_CLASS[toneOf(entry)]}`}>{entry.status ?? 'err'}</span>
        <span className="w-16 shrink-0 text-fg-subtle">{entry.durationMs} ms</span>
      </button>
      <div className="flex shrink-0 items-center gap-1">
        <Button variant="ghost" onClick={onResend} title="Re-send">
          ↻
        </Button>
        <Button variant="ghost" onClick={onCompare} title="Compare…" aria-pressed={compareArmed}>
          ⇄
        </Button>
        <Button variant="ghost" onClick={onCompareWithCurrent} title="Compare with current">
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
  const openTab = useEditorsStore((state) => state.open);
  const openOrReplaceTab = useEditorsStore((state) => state.openOrReplace);
  const [compareFirst, setCompareFirst] = useState<string | undefined>(undefined);
  const [confirmingClear, setConfirmingClear] = useState(false);
  const scrollRef = useRef<HTMLDivElement>(null);

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
    void ipc()
      .history.resend({ id: entry.id })
      .then((result) => {
        if (!result.ok) {
          showToast(result.error.code);
        }
      });
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
        <div ref={scrollRef} className="min-h-0 flex-1 overflow-auto">
          {virtualised ? (
            <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
              {virtualizer.getVirtualItems().map((item) => {
                const entry = entries[item.index];
                return entry === undefined ? null : (
                  <div
                    key={entry.id}
                    style={{ position: 'absolute', top: item.start, left: 0, right: 0, height: item.size }}
                  >
                    <Row
                      entry={entry}
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
            entries.map((entry) => (
              <div key={entry.id} style={{ height: ROW_HEIGHT }}>
                <Row
                  entry={entry}
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
