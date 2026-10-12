/**
 * The hosts connected to lately on this machine: one entry per host with when and how its last connect went.
 * Kept in `localStorage` by workspace (host ids are the workspace's), never in the workspace itself and never
 * with credentials: an entry is a host id, a time and an outcome. A deleted host keeps its entry until it
 * falls off the end, but nothing lists it; a renamed one shows by its current name, as its id stays.
 */
import { useMemo } from 'react';
import { create } from 'zustand';
import { useWorkspaceStore } from '../../state/workspace.js';

export const RECENT_KEY = 'wirebench.ssh.recent';
/** How many hosts the list remembers. */
export const RECENT_LIMIT = 20;

export type RecentOutcome = 'connected' | 'failed';

export interface RecentConnection {
  readonly hostId: string;
  /** Epoch milliseconds of the connect's end. */
  readonly at: number;
  readonly outcome: RecentOutcome;
}

/** `entries` with `entry` in front, any older entry of its host gone, cut to {@link RECENT_LIMIT}. */
export function addRecent(entries: readonly RecentConnection[], entry: RecentConnection): RecentConnection[] {
  return [entry, ...entries.filter((e) => e.hostId !== entry.hostId)].slice(0, RECENT_LIMIT);
}

function readAll(storage: Storage): Record<string, unknown> {
  try {
    const raw = storage.getItem(RECENT_KEY);
    if (raw === null) return {};
    const parsed: unknown = JSON.parse(raw);
    return typeof parsed === 'object' && parsed !== null && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

function isEntry(value: unknown): value is RecentConnection {
  if (typeof value !== 'object' || value === null) return false;
  const { hostId, at, outcome } = value as Record<string, unknown>;
  return typeof hostId === 'string' && typeof at === 'number' && (outcome === 'connected' || outcome === 'failed');
}

/** The stored list of `workspaceId`, newest first; malformed entries are skipped. */
export function readRecent(workspaceId: string, storage: Storage = localStorage): RecentConnection[] {
  const list = readAll(storage)[workspaceId];
  return Array.isArray(list) ? list.filter(isEntry).map(({ hostId, at, outcome }) => ({ hostId, at, outcome })) : [];
}

export function writeRecent(
  workspaceId: string,
  entries: readonly RecentConnection[],
  storage: Storage = localStorage,
): void {
  const clean = entries.map(({ hostId, at, outcome }) => ({ hostId, at, outcome }));
  try {
    storage.setItem(RECENT_KEY, JSON.stringify({ ...readAll(storage), [workspaceId]: clean }));
  } catch {
    // A full or blocked storage only costs the list.
  }
}

/** The hosts of `entries` that still exist, newest first. */
export function recentHostIds(entries: readonly RecentConnection[], known: ReadonlySet<string>): string[] {
  return entries.filter((e) => known.has(e.hostId)).map((e) => e.hostId);
}

/** When each host's last connect ended. */
export function lastConnectedOf(entries: readonly RecentConnection[]): Map<string, number> {
  return new Map(entries.map((e) => [e.hostId, e.at] as const));
}

interface RecentState {
  /** Bumped by every change, so the views read the list again. */
  version: number;
  /** Notes a connect's end for the open workspace; nothing with no workspace open. */
  record: (hostId: string, outcome: RecentOutcome, at?: number) => void;
  /** Forgets the open workspace's list. */
  clear: () => void;
}

export const useRecentStore = create<RecentState>()((set, get) => ({
  version: 0,
  record: (hostId, outcome, at = Date.now()) => {
    const workspaceId = useWorkspaceStore.getState().workspace?.id;
    if (workspaceId === undefined) return;
    writeRecent(workspaceId, addRecent(readRecent(workspaceId), { hostId, at, outcome }));
    set({ version: get().version + 1 });
  },
  clear: () => {
    const workspaceId = useWorkspaceStore.getState().workspace?.id;
    if (workspaceId === undefined) return;
    writeRecent(workspaceId, []);
    set({ version: get().version + 1 });
  },
}));

const EMPTY: readonly RecentConnection[] = [];

/** The open workspace's list, newest first; empty with no workspace open. */
export function useRecentConnections(): readonly RecentConnection[] {
  const workspaceId = useWorkspaceStore((s) => s.workspace?.id);
  const version = useRecentStore((s) => s.version);
  return useMemo(
    () => (workspaceId === undefined ? EMPTY : readRecent(workspaceId)),
    // `version` is what says the stored list changed.
    [workspaceId, version],
  );
}
