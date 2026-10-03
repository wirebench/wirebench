/**
 * The Audit tab's state (audit-log spec §3.6). The same stale-answer guard as `state/license.ts`: a
 * `load` that is no longer the latest is dropped, and `reset` bumps the epoch so a late answer from a
 * closed dialog changes nothing. The filter lives here so reopening the tab keeps it within a session.
 */
import { create } from 'zustand';
import type { AuditEventWire, AuditQueryWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import { rangeOf, type ActionGroup, type RangePreset } from './audit-format.js';
import { ipc } from './ipc-client.js';

export interface AuditFilter {
  readonly range: RangePreset;
  readonly group: ActionGroup | 'all';
  readonly workspaceId: string | undefined;
  /** The team whose events are read: set for a team admin, left out for a server admin (all events). */
  readonly teamId: string | undefined;
}

export interface AuditSnapshot {
  readonly events: readonly AuditEventWire[];
  readonly next: string | undefined;
  readonly loaded: boolean;
  readonly loading: boolean;
  readonly loadingMore: boolean;
  readonly exporting: boolean;
  readonly error: string | undefined;
  /** The problem code, so the tab branches on `licensing-feature-required` rather than on message text. */
  readonly errorCode: string | undefined;
  readonly filter: AuditFilter;
  readonly selectedId: string | undefined;
}

interface AuditActions {
  setFilter(url: string, patch: Partial<AuditFilter>): Promise<void>;
  /** Moves the scope to another team: drops the rows and the workspace narrowing, then reloads. */
  setTeam(url: string, teamId: string | undefined): Promise<void>;
  load(url: string): Promise<void>;
  loadMore(url: string): Promise<void>;
  select(id: string | undefined): void;
  exportToFile(url: string): Promise<void>;
  reset(): void;
}

export const PAGE_SIZE = 50;

const EMPTY: AuditSnapshot = {
  events: [],
  next: undefined,
  loaded: false,
  loading: false,
  loadingMore: false,
  exporting: false,
  error: undefined,
  errorCode: undefined,
  filter: { range: '7d', group: 'all', workspaceId: undefined, teamId: undefined },
  selectedId: undefined,
};

/** The filter as a query, without paging: what an export sends, since it streams every match. */
export function filterQueryOf(filter: AuditFilter, now: Date): AuditQueryWire {
  const range = rangeOf(filter.range, now);
  return {
    ...(range.from !== undefined ? { from: range.from } : {}),
    ...(filter.group !== 'all' ? { action: `${filter.group}.` } : {}),
    ...(filter.workspaceId !== undefined ? { workspaceId: filter.workspaceId } : {}),
    ...(filter.teamId !== undefined ? { teamId: filter.teamId } : {}),
  };
}

export function queryOf(filter: AuditFilter, now: Date, after?: string): AuditQueryWire {
  return { ...filterQueryOf(filter, now), ...(after !== undefined ? { after } : {}), limit: PAGE_SIZE };
}

let loads = 0;
let epoch = 0;

export const useAuditStore = create<AuditSnapshot & AuditActions>((set, get) => ({
  ...EMPTY,
  async setFilter(url, patch) {
    set({ filter: { ...get().filter, ...patch }, selectedId: undefined });
    await get().load(url);
  },
  async setTeam(url, teamId) {
    if (get().filter.teamId === teamId) return;
    set({
      filter: { ...get().filter, teamId, workspaceId: undefined },
      events: [],
      next: undefined,
      selectedId: undefined,
    });
    await get().load(url);
  },
  async load(url) {
    const mine = ++loads;
    const started = epoch;
    set({ loading: true, loadingMore: false, error: undefined, errorCode: undefined });
    const result = await ipc().audit.query({ url, query: queryOf(get().filter, new Date()) });
    if (mine !== loads || started !== epoch) return;
    if (result.ok) set({ events: result.value.events, next: result.value.next, loaded: true, loading: false });
    else
      set({
        loaded: true,
        loading: false,
        error: result.error.message,
        errorCode: result.error.code,
        events: [],
        next: undefined,
      });
  },
  async loadMore(url) {
    const { next, filter, loadingMore } = get();
    if (next === undefined || loadingMore) return;
    const started = epoch;
    const mine = loads;
    set({ loadingMore: true });
    const result = await ipc().audit.query({ url, query: queryOf(filter, new Date(), next) });
    if (started !== epoch || mine !== loads) return;
    if (result.ok)
      set((s) => ({ events: [...s.events, ...result.value.events], next: result.value.next, loadingMore: false }));
    else set({ loadingMore: false, error: result.error.message, errorCode: result.error.code });
  },
  select(id) {
    set({ selectedId: id });
  },
  async exportToFile(url) {
    const query = filterQueryOf(get().filter, new Date());
    const started = epoch;
    set({ exporting: true });
    const result = await ipc().audit.export({ url, query });
    if (started !== epoch) return;
    set({ exporting: false });
    if (!result.ok) showToast(result.error.message);
    else if (result.value.saved) showToast(`Exported ${String(result.value.count)} events to ${result.value.path}`);
  },
  reset() {
    loads += 1;
    epoch += 1;
    set(EMPTY);
  },
}));
