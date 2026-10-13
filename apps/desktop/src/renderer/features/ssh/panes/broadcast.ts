/**
 * Broadcast input (spec D6): per terminal tab, keystrokes in a ticked pane go to every ticked pane. The state
 * lives here, never on the tab's pane tree, so a saved layout can never carry it and a reopened tab never
 * starts broadcasting.
 */
import { create } from 'zustand';

export interface BroadcastState {
  on: boolean;
  /** Pane ids. */
  ticked: ReadonlySet<string>;
}

/** A tab's broadcast, with how many panes the last write skipped. */
export interface TabBroadcast extends BroadcastState {
  readonly missed: number;
}

const OFF: TabBroadcast = { on: false, ticked: new Set(), missed: 0 };

/** The sessions a keystroke in `fromPane` goes to. */
export function receiversFor(
  state: BroadcastState,
  fromPane: string,
  sessions: Readonly<Record<string, string | undefined>>,
): string[] {
  const panes = state.on && state.ticked.has(fromPane) ? [...state.ticked] : [fromPane];
  return panes.flatMap((paneId) => {
    const sessionId = sessions[paneId];
    return sessionId === undefined ? [] : [sessionId];
  });
}

interface BroadcastStore {
  readonly tabs: Readonly<Record<string, TabBroadcast>>;
}

export const useBroadcastStore = create<BroadcastStore>(() => ({ tabs: {} }));

export function broadcastOf(tabId: string): TabBroadcast {
  return useBroadcastStore.getState().tabs[tabId] ?? OFF;
}

/** A hook form of `broadcastOf`, re-rendering on the tab's changes only. */
export function useTabBroadcast(tabId: string): TabBroadcast {
  return useBroadcastStore((s) => s.tabs[tabId]) ?? OFF;
}

function set(tabId: string, next: TabBroadcast | undefined): void {
  useBroadcastStore.setState((s) => {
    const tabs = { ...s.tabs };
    if (next === undefined || !next.on) delete tabs[tabId];
    else tabs[tabId] = next;
    return { tabs };
  });
}

/** Turns a tab's broadcast on with every pane ticked, or off. It needs two or more panes. */
export function toggleBroadcast(tabId: string, paneIds: readonly string[]): void {
  if (broadcastOf(tabId).on || paneIds.length < 2) set(tabId, undefined);
  else set(tabId, { on: true, ticked: new Set(paneIds), missed: 0 });
}

export function stopBroadcast(tabId: string): void {
  set(tabId, undefined);
}

export function setTicked(tabId: string, paneId: string, ticked: boolean): void {
  const current = broadcastOf(tabId);
  if (!current.on) return;
  const next = new Set(current.ticked);
  if (ticked) next.add(paneId);
  else next.delete(paneId);
  set(tabId, { ...current, ticked: next });
}

/** Records how many receivers a broadcast write skipped; a write that reached them all clears it. */
export function noteWriteMany(tabId: string, skipped: number): void {
  const current = broadcastOf(tabId);
  if (current.on && current.missed !== skipped) set(tabId, { ...current, missed: skipped });
}

/** Follows the tab's panes: a closed pane leaves the ticks, and fewer than two panes ends the broadcast. */
export function pruneBroadcast(tabId: string, paneIds: readonly string[]): void {
  const current = broadcastOf(tabId);
  if (!current.on) return;
  if (paneIds.length < 2) {
    set(tabId, undefined);
    return;
  }
  const ticked = new Set([...current.ticked].filter((id) => paneIds.includes(id)));
  if (ticked.size !== current.ticked.size) set(tabId, { ...current, ticked });
}
