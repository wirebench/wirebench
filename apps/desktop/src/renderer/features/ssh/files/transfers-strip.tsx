import { useState } from 'react';
import { ArrowDown, ArrowRight, ArrowUp, Check, ChevronDown, ChevronUp } from 'lucide-react';
import { useShallow } from 'zustand/react/shallow';
import { formatSize } from './format.js';
import { isFinal, rowsOf, useTransfersStore } from './transfers-store.js';
import type { TransferBatch, TransferRow } from './transfers-store.js';

const LINK = 'rounded px-1.5 text-xs text-fg-default hover:bg-surface-hover disabled:opacity-50';

const STATE_LABEL: Record<TransferRow['state'], string> = {
  queued: 'Queued',
  waiting: 'Waiting for an answer',
  running: '',
  done: 'Done',
  failed: 'Failed',
  cancelled: 'Cancelled',
  skipped: 'Skipped',
};

function Direction({ direction }: { readonly direction: TransferBatch['direction'] | undefined }) {
  if (direction === 'upload') return <ArrowUp size={12} aria-label="Upload" className="shrink-0" />;
  if (direction === 'download') return <ArrowDown size={12} aria-label="Download" className="shrink-0" />;
  return <ArrowRight size={12} aria-label="Copy" className="shrink-0" />;
}

function Row({ row, batch }: { readonly row: TransferRow; readonly batch: TransferBatch | undefined }) {
  const { cancel, retry } = useTransfersStore.getState();
  const percent = row.total > 0 ? Math.min(100, Math.round((row.done / row.total) * 100)) : 0;
  return (
    <li
      data-testid="files-transfer"
      data-state={row.state}
      className="flex items-center gap-2 px-3 py-1 text-xs text-fg-muted"
    >
      <Direction direction={batch?.direction} />
      <span className="min-w-0 flex-1 truncate">
        <span className="text-fg-default">{row.name}</span>
        {batch !== undefined && <span className="text-fg-subtle"> → {batch.toDir}</span>}
      </span>
      {row.state === 'failed' ? (
        <span className="max-w-64 truncate text-status-danger" title={row.error?.message}>
          {row.error?.message ?? STATE_LABEL.failed}
        </span>
      ) : row.state === 'running' ? (
        <>
          <span className="tabular-nums">
            {formatSize(row.done)} / {formatSize(row.total)}
          </span>
          <span className="w-20 text-right tabular-nums">{formatSize(row.bytesPerSecond)}/s</span>
          <span className="h-1 w-24 overflow-hidden rounded bg-surface-hover" aria-hidden="true">
            <span className="block h-full bg-accent" style={{ width: `${String(percent)}%` }} />
          </span>
        </>
      ) : (
        <span className="flex items-center gap-1">
          {row.state === 'done' && <Check size={12} aria-hidden="true" className="text-status-success" />}
          {STATE_LABEL[row.state]}
        </span>
      )}
      {!isFinal(row) && (
        <button
          type="button"
          className={LINK}
          onClick={() => {
            cancel(row.transferId);
          }}
        >
          Cancel
        </button>
      )}
      {(row.state === 'failed' || row.state === 'cancelled') && (
        <button
          type="button"
          className={LINK}
          onClick={() => {
            retry(row.transferId);
          }}
        >
          Retry
        </button>
      )}
    </li>
  );
}

/**
 * Under a Files tab's panes while any of its copies is listed: a row per file with its direction, name and
 * target folder, bytes and speed with a bar while it runs, its end state once finished (a failed one with
 * the cause and Retry), Cancel until then, and Clear done. Collapses to its header.
 */
export function TransfersStrip({ tabId }: { readonly tabId: string }) {
  const rows = useTransfersStore(useShallow((s) => rowsOf(s, tabId)));
  const batches = useTransfersStore((s) => s.batches);
  const [open, setOpen] = useState(true);
  if (rows.length === 0) return null;
  const active = rows.filter((row) => !isFinal(row)).length;
  return (
    <section aria-label="Transfers" data-testid="files-transfers" className="shrink-0 border-t border-hairline">
      <div className="flex items-center gap-2 px-2 py-1 text-xs text-fg-subtle">
        <button
          type="button"
          aria-expanded={open}
          className="flex items-center gap-1 rounded px-1 hover:text-fg-default"
          onClick={() => {
            setOpen(!open);
          }}
        >
          {open ? <ChevronDown size={12} aria-hidden="true" /> : <ChevronUp size={12} aria-hidden="true" />}
          Transfers
        </button>
        <span className="min-w-0 flex-1">
          {active > 0 ? `${String(active)} in progress` : `${String(rows.length)} finished`}
        </span>
        <button
          type="button"
          className={LINK}
          disabled={!rows.some((row) => isFinal(row) && row.state !== 'failed')}
          onClick={() => {
            useTransfersStore.getState().clearDone(tabId);
          }}
        >
          Clear done
        </button>
      </div>
      {open && (
        <ul className="max-h-40 overflow-auto">
          {rows.map((row) => (
            <Row key={row.transferId} row={row} batch={batches[row.batchId]} />
          ))}
        </ul>
      )}
    </section>
  );
}
