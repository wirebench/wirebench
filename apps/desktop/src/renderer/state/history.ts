import { create } from 'zustand';
import type { HistoryAppendedEvent, HistoryEntryWire } from '../../shared/wire-types.js';
import { ipc } from './ipc-client.js';

/** Debounce delay for `search`, so fast typing doesn't fire one IPC round trip per keystroke. */
const SEARCH_DEBOUNCE_MS = 200;

/** The history store's serialisable state. */
export interface HistorySnapshot {
  readonly entries: readonly HistoryEntryWire[];
  readonly total: number;
  readonly query: string;
  readonly loading: boolean;
}

/** The history store: {@link HistorySnapshot} plus the actions the History view drives. */
export interface HistoryStore extends HistorySnapshot {
  /** Reloads `entries`/`total` from main for the current `query`. */
  readonly load: () => Promise<void>;
  /** Sets `query` immediately (so the input reflects it) and reloads after a short debounce. */
  readonly search: (query: string) => void;
  /** Clears every entry, both on disk and in the store. */
  readonly clear: () => Promise<void>;
  /** Prepends `entry` when it was appended live and matches the current search, if any. */
  readonly onAppended: (entry: HistoryEntryWire) => void;
}

/** Case-insensitive substring test mirroring the engine's own `history.ts` search fields. */
function matchesQuery(entry: HistoryEntryWire, query: string): boolean {
  if (query.trim().length === 0) {
    return true;
  }
  const needle = query.toLowerCase();
  const haystack = [
    entry.requestName,
    entry.operationName,
    entry.interfaceName,
    entry.endpoint,
    entry.status !== undefined ? String(entry.status) : '',
    entry.fault?.reason ?? '',
    ...(entry.tags ?? []),
  ]
    .join('\n')
    .toLowerCase();
  return haystack.includes(needle);
}

let debounceTimer: ReturnType<typeof setTimeout> | undefined;

export const useHistoryStore = create<HistoryStore>((set, get) => ({
  entries: [],
  total: 0,
  query: '',
  loading: false,

  load: async () => {
    set({ loading: true });
    const { query } = get();
    const result = await ipc().history.list({ ...(query.length > 0 ? { query } : {}) });
    if (result.ok) {
      set({ entries: result.value.entries, total: result.value.total, loading: false });
    } else {
      set({ loading: false });
    }
  },

  search: (query) => {
    set({ query });
    if (debounceTimer !== undefined) {
      clearTimeout(debounceTimer);
    }
    debounceTimer = setTimeout(() => {
      void get().load();
    }, SEARCH_DEBOUNCE_MS);
  },

  clear: async () => {
    const result = await ipc().history.clear(undefined);
    if (result.ok) {
      set({ entries: [], total: 0 });
    }
  },

  onAppended: (entry) => {
    const { query, entries, total } = get();
    if (!matchesQuery(entry, query)) {
      return;
    }
    set({ entries: [entry, ...entries], total: total + 1 });
  },
}));

/**
 * Subscribes the store to `history.appended` and pulls the initial page. Called once from the
 * shell; returns an unsubscribe for symmetry with React effects (mirrors `subscribeToProject`).
 *
 * Also reloads on `workspace.changed` and `project.changed`: main keeps one history file per
 * open project and `history.list` merges them, so opening or closing a workspace — or adding,
 * removing or reloading a project inside one — changes what the list should show, and waiting
 * for the next send would leave it stale.
 */
export function subscribeToHistory(): () => void {
  void useHistoryStore.getState().load();
  const offAppended = window.wirebench.on('history.appended', ((payload: HistoryAppendedEvent) => {
    useHistoryStore.getState().onAppended(payload.entry);
  }) as (payload: unknown) => void);
  const reload = (): void => {
    void useHistoryStore.getState().load();
  };
  const offProjectChanged = window.wirebench.on('project.changed', reload);
  const offWorkspaceChanged = window.wirebench.on('workspace.changed', reload);
  return () => {
    offAppended();
    offProjectChanged();
    offWorkspaceChanged();
  };
}
