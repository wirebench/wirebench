/**
 * What the user does to a terminal tab's panes: split one (through the host picker), move the focus,
 * resize a divider, close one. The tree lives on the tab in the editors store; this store keeps which pane
 * has the focus in each tab and the split waiting on the picker.
 */
import { create } from 'zustand';
import { showToast } from '../../../components/toast.js';
import { useEditorsStore } from '../../../state/editors.js';
import { close, leaves, MAX_PANES, neighbour, setRatio, split } from './pane-tree.js';
import type { PaneNode } from './pane-tree.js';

export type SplitDir = 'row' | 'column';
export type FocusDirection = 'left' | 'right' | 'up' | 'down';

/**
 * The fewest columns either half of a split right keeps. Narrower than this a terminal's prompt wraps
 * and its find bar no longer fits, so a pane under twice this is refused a further split with a toast
 * (not stacked: the split's direction is the user's layout, and a saved layout keeps it).
 */
export const MIN_SPLIT_COLS = 40;
/** The fewest rows either half of a split down keeps. */
export const MIN_SPLIT_ROWS = 5;

/** A split waiting on the host picker: the pane it divides, and the host the picker starts on. */
export interface PendingSplit {
  readonly tabId: string;
  readonly paneId: string;
  readonly dir: SplitDir;
  readonly hostId: string;
}

interface PanesState {
  /** Per tab, the pane keystrokes go to; a tab not listed focuses its first pane. */
  readonly focused: Readonly<Record<string, string>>;
  readonly picker: PendingSplit | undefined;
}

export const usePanesStore = create<PanesState>(() => ({ focused: {}, picker: undefined }));

/** Each pane's terminal size, as its last fit measured it. Only a split's size check reads it. */
const sizes = new Map<string, { cols: number; rows: number }>();

export function notePaneSize(paneId: string, size: { cols: number; rows: number }): void {
  sizes.set(paneId, size);
}

export function forgetPaneSize(paneId: string): void {
  sizes.delete(paneId);
}

/** Whether a pane of this size splits in `dir` with both halves at least 40 columns or 5 rows. */
export function splitFits(size: { cols: number; rows: number }, dir: SplitDir): boolean {
  return dir === 'row' ? Math.floor(size.cols / 2) >= MIN_SPLIT_COLS : Math.floor(size.rows / 2) >= MIN_SPLIT_ROWS;
}

function treeOf(tabId: string): PaneNode | undefined {
  return useEditorsStore.getState().tabs.find((tab) => tab.id === tabId)?.panes;
}

function setTree(tabId: string, panes: PaneNode): void {
  useEditorsStore.setState((state) => ({
    tabs: state.tabs.map((tab) => (tab.id === tabId ? { ...tab, panes } : tab)),
  }));
}

/** The terminal tab in front, with its tree. */
export function activeTerminal(): { readonly tabId: string; readonly panes: PaneNode } | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  const tab = tabs.find((t) => t.id === activeId);
  return tab?.kind === 'ssh-terminal' && tab.panes !== undefined ? { tabId: tab.id, panes: tab.panes } : undefined;
}

/** The pane that has the focus in a tab: the one last focused while it is still there, else the first. */
export function focusedPaneOf(tabId: string, panes: PaneNode): string | undefined {
  const all = leaves(panes);
  const stored = usePanesStore.getState().focused[tabId];
  return all.some((leaf) => leaf.paneId === stored) ? stored : all[0]?.paneId;
}

export function focusPane(tabId: string, paneId: string): void {
  if (usePanesStore.getState().focused[tabId] === paneId) return;
  usePanesStore.setState((state) => ({ focused: { ...state.focused, [tabId]: paneId } }));
}

/**
 * Opens the host picker to split a pane (the focused one unless named), preselected on its host. A tab
 * already at {@link MAX_PANES}, or a pane too small to halve, is refused with a toast instead.
 */
export function requestSplit(tabId: string, dir: SplitDir, paneId?: string): void {
  const panes = treeOf(tabId);
  if (panes === undefined) return;
  const target = paneId ?? focusedPaneOf(tabId, panes);
  const leaf = leaves(panes).find((l) => l.paneId === target);
  if (leaf === undefined) return;
  if (leaves(panes).length >= MAX_PANES) {
    showToast(`A tab holds at most ${String(MAX_PANES)} panes`);
    return;
  }
  const size = sizes.get(leaf.paneId);
  if (size !== undefined && !splitFits(size, dir)) {
    showToast(
      dir === 'row'
        ? `Too narrow to split: each half needs ${String(MIN_SPLIT_COLS)} columns`
        : `Too short to split: each half needs ${String(MIN_SPLIT_ROWS)} rows`,
    );
    return;
  }
  usePanesStore.setState({ picker: { tabId, paneId: leaf.paneId, dir, hostId: leaf.hostId } });
}

/** The picker's Enter: the new pane on `hostId` takes the second half and the focus, and connects as it mounts. */
export function completeSplit(hostId: string): void {
  const pending = usePanesStore.getState().picker;
  usePanesStore.setState({ picker: undefined });
  if (pending === undefined) return;
  const panes = treeOf(pending.tabId);
  if (panes === undefined) return;
  let next: PaneNode;
  try {
    next = split(panes, pending.paneId, pending.dir, hostId);
  } catch (error) {
    showToast(error instanceof Error ? error.message : 'The pane could not be split');
    return;
  }
  const before = new Set(leaves(panes).map((leaf) => leaf.paneId));
  const added = leaves(next).find((leaf) => !before.has(leaf.paneId));
  setTree(pending.tabId, next);
  if (added !== undefined) focusPane(pending.tabId, added.paneId);
}

export function cancelSplit(): void {
  usePanesStore.setState({ picker: undefined });
}

/**
 * Closes a pane; its session ends as the pane unmounts. The sibling takes the space and, when the closed
 * pane had the focus, the focus too. The last pane closes the tab.
 */
export function closePane(tabId: string, paneId: string): void {
  const panes = treeOf(tabId);
  if (panes === undefined) return;
  const next = close(panes, paneId);
  if (next === undefined) {
    useEditorsStore.getState().close(tabId);
    return;
  }
  if (focusedPaneOf(tabId, panes) === paneId) {
    const directions: readonly FocusDirection[] = ['left', 'up', 'right', 'down'];
    const near = directions.map((d) => neighbour(panes, paneId, d)).find((id) => id !== undefined);
    const heir = leaves(next).some((leaf) => leaf.paneId === near) ? near : leaves(next)[0]?.paneId;
    if (heir !== undefined) focusPane(tabId, heir);
  }
  setTree(tabId, next);
}

/** ⌘⌥ + arrow: focuses the neighbouring pane of the terminal tab in front; at the tab's edge nothing moves. */
export function moveFocus(direction: FocusDirection): void {
  const active = activeTerminal();
  if (active === undefined) return;
  const from = focusedPaneOf(active.tabId, active.panes);
  const to = from === undefined ? undefined : neighbour(active.panes, from, direction);
  if (to !== undefined) focusPane(active.tabId, to);
}

/** A divider's drag or double-click: the ratio of the split `path` leads to. */
export function resizeSplit(tabId: string, path: readonly ('a' | 'b')[], ratio: number): void {
  const panes = treeOf(tabId);
  if (panes === undefined) return;
  const next = setRatio(panes, path, ratio);
  if (next !== panes) setTree(tabId, next);
}
