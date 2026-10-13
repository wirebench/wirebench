/**
 * How the Hosts tab is laid out, per workspace: cards or rows, the sort, and the groups folded away.
 * Kept in `localStorage` like the rest of the renderer's per-device UI state: losing it only resets
 * the view.
 */
import { useCallback, useState } from 'react';
import { useWorkspaceStore } from '../../state/workspace.js';

export const HOSTS_PREFS_KEY = 'wirebench.ssh.hostsView';

export type HostsLayout = 'grid' | 'list';
export type HostsSort = 'name' | 'address' | 'connected' | 'recent';

export interface HostsPrefs {
  readonly layout: HostsLayout;
  readonly sort: HostsSort;
  /** Group ids folded away; `TOP_LEVEL` stands for the hosts outside any group. */
  readonly collapsed: readonly string[];
}

/** The section of the hosts outside any group, as `collapsed` names it. */
export const TOP_LEVEL = '(top)';

export const DEFAULT_HOSTS_PREFS: HostsPrefs = { layout: 'grid', sort: 'name', collapsed: [] };

const LAYOUTS: readonly string[] = ['grid', 'list'];
const SORTS: readonly string[] = ['name', 'address', 'connected', 'recent'];

function readAll(storage: Storage): Record<string, unknown> {
  try {
    const raw = storage.getItem(HOSTS_PREFS_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The stored prefs of `workspaceId`; anything missing or malformed falls back to the default. */
export function readHostsPrefs(workspaceId: string, storage: Storage = localStorage): HostsPrefs {
  const entry = readAll(storage)[workspaceId];
  if (typeof entry !== 'object' || entry === null) return DEFAULT_HOSTS_PREFS;
  const { layout, sort, collapsed } = entry as Record<string, unknown>;
  return {
    layout: typeof layout === 'string' && LAYOUTS.includes(layout) ? (layout as HostsLayout) : 'grid',
    sort: typeof sort === 'string' && SORTS.includes(sort) ? (sort as HostsSort) : 'name',
    collapsed: Array.isArray(collapsed) ? collapsed.filter((id): id is string => typeof id === 'string') : [],
  };
}

export function writeHostsPrefs(workspaceId: string, prefs: HostsPrefs, storage: Storage = localStorage): void {
  try {
    storage.setItem(HOSTS_PREFS_KEY, JSON.stringify({ ...readAll(storage), [workspaceId]: prefs }));
  } catch {
    // A full or blocked storage only costs the remembered view.
  }
}

/** The open workspace's prefs, and a setter that remembers each change. */
export function useHostsPrefs(): readonly [HostsPrefs, (change: Partial<HostsPrefs>) => void] {
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id);
  const [state, setState] = useState<{ id: string | undefined; prefs: HostsPrefs }>(() => ({
    id: workspaceId,
    prefs: workspaceId === undefined ? DEFAULT_HOSTS_PREFS : readHostsPrefs(workspaceId),
  }));
  // Another workspace opened while the tab stayed mounted: take up its own prefs.
  const prefs =
    state.id === workspaceId
      ? state.prefs
      : workspaceId === undefined
        ? DEFAULT_HOSTS_PREFS
        : readHostsPrefs(workspaceId);
  const update = useCallback(
    (change: Partial<HostsPrefs>) => {
      const next = { ...prefs, ...change };
      setState({ id: workspaceId, prefs: next });
      if (workspaceId !== undefined) writeHostsPrefs(workspaceId, next);
    },
    [prefs, workspaceId],
  );
  return [prefs, update] as const;
}
