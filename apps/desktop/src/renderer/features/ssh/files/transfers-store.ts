/**
 * The Files tabs' copies, as main reports them: each batch this window started (what it copies, from which
 * pane to which), each transfer's latest `sftp.transfer` event, the conflict questions waiting for an answer,
 * and whether closing a tab with copies still running is being asked about. Main runs the queue; this store
 * only shows it and sends the user's answers back.
 */
import { create } from 'zustand';
import type {
  ConflictDecisionWire,
  SftpConflictEvent,
  SftpCopyRequest,
  SftpTransferEvent,
} from '../../../../shared/sftp-wire.js';
import { showToast } from '../../../components/toast.js';
import { useEditorsStore } from '../../../state/editors.js';
import { ipc } from '../../../state/ipc-client.js';
import { placeWireOf, settle, tabOfPane, useFilesStore } from './files-store.js';
import { joinPath } from './format.js';

export interface TransferBatch {
  readonly batchId: string;
  readonly tabId: string;
  /** The pane copied into, refreshed when the batch finishes. */
  readonly toPaneId: string;
  readonly toDir: string;
  /** This machine to the host, the host to this machine, or within one side. */
  readonly direction: 'upload' | 'download' | 'copy';
}

export type TransferRow = SftpTransferEvent;

const FINAL: ReadonlySet<TransferRow['state']> = new Set(['done', 'failed', 'cancelled', 'skipped']);

/** A state a transfer never leaves on its own: done, failed, cancelled or skipped. */
export function isFinal(row: Pick<TransferRow, 'state'>): boolean {
  return FINAL.has(row.state);
}

interface TransfersState {
  readonly batches: Readonly<Record<string, TransferBatch>>;
  /** By transfer id, in arrival order. */
  readonly rows: Readonly<Record<string, TransferRow>>;
  /** Per tab: conflict questions, the first one shown. */
  readonly conflicts: Readonly<Record<string, readonly SftpConflictEvent[]>>;
  /** Tabs whose close is waiting on "cancel the copies?". */
  readonly closing: Readonly<Record<string, boolean>>;
  /** Copies the named entries of one pane into the other pane's folder, or into `toDir` there. */
  copy: (fromPaneId: string, names: readonly string[], toPaneId: string, toDir?: string) => Promise<void>;
  /** Copies paths of this machine (dropped from the OS) into a pane's folder, or into `toDir` there. */
  upload: (paths: readonly string[], toPaneId: string, toDir?: string) => Promise<void>;
  onTransfer: (event: SftpTransferEvent) => void;
  onConflict: (event: SftpConflictEvent) => void;
  /** Answers the tab's first question; `applyToRest` answers the rest of that batch's clashes too. */
  answer: (tabId: string, decision: ConflictDecisionWire, applyToRest: boolean) => void;
  cancel: (transferId: string) => void;
  retry: (transferId: string) => void;
  /** Drops the tab's finished rows: done, skipped and cancelled (failed ones stay, with Retry). */
  clearDone: (tabId: string) => void;
  /** `true` when the tab has copies running: the close waits for {@link confirmClose}. */
  holdClose: (tabId: string) => boolean;
  /** Cancels the tab's copies and closes it. */
  confirmClose: (tabId: string) => void;
  dismissClose: (tabId: string) => void;
  /** The tab closed: its rows, batches and questions go. */
  forgetTab: (tabId: string) => void;
}

/** The rows of one tab, in arrival order. */
export function rowsOf(state: Pick<TransfersState, 'rows' | 'batches'>, tabId: string): TransferRow[] {
  return Object.values(state.rows).filter((row) => state.batches[row.batchId]?.tabId === tabId);
}

/** Batches through since their last refresh: a retry makes one unsettled again. */
const settled = new Set<string>();

function directionOf(from: 'local' | 'remote', to: 'local' | 'remote'): TransferBatch['direction'] {
  if (from === to) return 'copy';
  return from === 'local' ? 'upload' : 'download';
}

export const useTransfersStore = create<TransfersState>()((set, get) => {
  /** Registers the batch before asking main, whose first events arrive before its answer. */
  const start = async (batch: TransferBatch, request: SftpCopyRequest): Promise<void> => {
    set({ batches: { ...get().batches, [batch.batchId]: batch } });
    const copied = await settle(() => ipc().sftp.copy(request), 'The copy could not start');
    if (!copied.ok) {
      showToast(copied.error.message);
      const batches = { ...get().batches };
      delete batches[batch.batchId];
      set({ batches });
    }
  };

  /** The pane's place and the folder to copy into: `toDir`, or the folder it shows. */
  const target = (toPaneId: string, toDir: string | undefined) => {
    const pane = useFilesStore.getState().panes[toPaneId];
    const place = pane === undefined ? undefined : placeWireOf(pane);
    const dir = toDir ?? pane?.path ?? '';
    return place === undefined || dir === '' ? undefined : { place, dir };
  };

  const batchOf = (
    toPaneId: string,
    to: { place: { kind: 'local' | 'remote' }; dir: string },
    from: 'local' | 'remote',
  ): TransferBatch => ({
    batchId: crypto.randomUUID(),
    tabId: tabOfPane(toPaneId),
    toPaneId,
    toDir: to.dir,
    direction: directionOf(from, to.place.kind),
  });

  return {
    batches: {},
    rows: {},
    conflicts: {},
    closing: {},

    copy: async (fromPaneId, names, toPaneId, toDir) => {
      const source = useFilesStore.getState().panes[fromPaneId];
      const from = source === undefined ? undefined : placeWireOf(source);
      const to = target(toPaneId, toDir);
      if (source === undefined || from === undefined || to === undefined || names.length === 0) return;
      const batch = batchOf(toPaneId, to, from.kind);
      await start(batch, {
        batchId: batch.batchId,
        from: { place: from, paths: names.map((name) => joinPath(source.path, name)) },
        to,
      });
    },

    upload: async (paths, toPaneId, toDir) => {
      const to = target(toPaneId, toDir);
      if (to === undefined || paths.length === 0) return;
      const batch = batchOf(toPaneId, to, 'local');
      await start(batch, { batchId: batch.batchId, from: { place: { kind: 'local' }, paths: [...paths] }, to });
    },

    onTransfer: (event) => {
      const batch = get().batches[event.batchId];
      if (batch === undefined) return;
      const rows = { ...get().rows, [event.transferId]: event };
      set({ rows });
      const ofBatch = Object.values(rows).filter((row) => row.batchId === event.batchId);
      if (!ofBatch.every(isFinal)) {
        settled.delete(event.batchId);
      } else if (!settled.has(event.batchId)) {
        // The receiving pane shows what arrived once its batch is through.
        settled.add(event.batchId);
        void useFilesStore
          .getState()
          .refresh(batch.toPaneId)
          .catch(() => undefined);
      }
    },

    onConflict: (event) => {
      const batch = get().batches[event.batchId];
      if (batch === undefined) return;
      const queued = get().conflicts[batch.tabId] ?? [];
      set({ conflicts: { ...get().conflicts, [batch.tabId]: [...queued, event] } });
    },

    answer: (tabId, decision, applyToRest) => {
      const [first, ...rest] = get().conflicts[tabId] ?? [];
      if (first === undefined) return;
      set({ conflicts: { ...get().conflicts, [tabId]: rest } });
      void ipc()
        .sftp.resolve({ batchId: first.batchId, decision, applyToRest })
        .catch(() => undefined);
    },

    cancel: (transferId) => {
      void ipc()
        .sftp.cancel({ transferId })
        .catch(() => undefined);
    },

    retry: (transferId) => {
      void ipc()
        .sftp.retry({ transferId })
        .catch(() => undefined);
    },

    clearDone: (tabId) => {
      const { rows, batches } = get();
      const kept = Object.fromEntries(
        Object.entries(rows).filter(
          ([, row]) => batches[row.batchId]?.tabId !== tabId || !isFinal(row) || row.state === 'failed',
        ),
      );
      set({ rows: kept });
    },

    holdClose: (tabId) => {
      if (!rowsOf(get(), tabId).some((row) => !isFinal(row))) return false;
      set({ closing: { ...get().closing, [tabId]: true } });
      return true;
    },

    confirmClose: (tabId) => {
      for (const row of rowsOf(get(), tabId)) if (!isFinal(row)) get().cancel(row.transferId);
      get().forgetTab(tabId);
      useEditorsStore.getState().close(tabId);
    },

    dismissClose: (tabId) => {
      set({ closing: { ...get().closing, [tabId]: false } });
    },

    forgetTab: (tabId) => {
      const { rows, batches, conflicts, closing } = get();
      const gone = new Set(
        Object.values(batches)
          .filter((b) => b.tabId === tabId)
          .map((b) => b.batchId),
      );
      for (const batchId of gone) settled.delete(batchId);
      const restConflicts = { ...conflicts };
      delete restConflicts[tabId];
      const restClosing = { ...closing };
      delete restClosing[tabId];
      set({
        rows: Object.fromEntries(Object.entries(rows).filter(([, row]) => !gone.has(row.batchId))),
        batches: Object.fromEntries(Object.entries(batches).filter(([id]) => !gone.has(id))),
        conflicts: restConflicts,
        closing: restClosing,
      });
    },
  };
});

/** Mounted Files tabs listening: the events are subscribed once while any is mounted. */
let listeners = 0;
let unsubscribe: (() => void) | undefined;

/** Starts listening to `sftp.transfer` and `sftp.conflict`; returns this listener's stop. */
export function listenToTransfers(): () => void {
  listeners += 1;
  if (listeners === 1) {
    const offTransfer = window.wirebench.on('sftp.transfer', ((event: SftpTransferEvent) => {
      useTransfersStore.getState().onTransfer(event);
    }) as (payload: unknown) => void);
    const offConflict = window.wirebench.on('sftp.conflict', ((event: SftpConflictEvent) => {
      useTransfersStore.getState().onConflict(event);
    }) as (payload: unknown) => void);
    unsubscribe = () => {
      offTransfer();
      offConflict();
    };
  }
  let stopped = false;
  return () => {
    if (stopped) return;
    stopped = true;
    listeners -= 1;
    if (listeners === 0) {
      unsubscribe?.();
      unsubscribe = undefined;
    }
  };
}
