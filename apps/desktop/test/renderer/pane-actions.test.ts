import { beforeEach, describe, expect, it, vi } from 'vitest';

const toast = vi.hoisted(() => vi.fn());
vi.mock('../../src/renderer/components/toast.js', () => ({ showToast: toast }));

import {
  cancelSplit,
  closePane,
  completeSplit,
  focusedPaneOf,
  moveFocus,
  notePaneSize,
  requestSplit,
  splitFits,
  usePanesStore,
} from '../../src/renderer/features/ssh/panes/pane-actions.js';
import { leaves, MAX_PANES, split, type PaneNode } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { openInNewTab, openTerminalFor } from '../../src/renderer/features/ssh/connect.js';
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';

const tab = () => useEditorsStore.getState().tabs.find((t) => t.kind === 'ssh-terminal');
const tree = (): PaneNode => {
  const panes = tab()?.panes;
  if (panes === undefined) throw new Error('no terminal tab');
  return panes;
};
const hosts = () => leaves(tree()).map((leaf) => leaf.hostId);

beforeEach(() => {
  toast.mockReset();
  useEditorsStore.getState().reset();
  usePanesStore.setState({ focused: {}, picker: undefined });
  useHostsStore.setState({
    file: { version: 1, groups: [], hosts: [] },
    resolved: [],
    panes: {},
    terminalTabUse: {},
  });
  openTerminalFor('a');
});

describe('splitFits', () => {
  it('needs 40 columns each side for a split right and 5 rows each for a split down', () => {
    expect(splitFits({ cols: 120, rows: 24 }, 'row')).toBe(true);
    expect(splitFits({ cols: 80, rows: 24 }, 'row')).toBe(true);
    // A 50-column pane (half of a 1024-pixel window) would leave two 25-column halves.
    expect(splitFits({ cols: 79, rows: 24 }, 'row')).toBe(false);
    expect(splitFits({ cols: 50, rows: 24 }, 'row')).toBe(false);
    expect(splitFits({ cols: 80, rows: 10 }, 'column')).toBe(true);
    expect(splitFits({ cols: 80, rows: 9 }, 'column')).toBe(false);
  });
});

describe('splitting', () => {
  it('opens the host picker on the focused pane, preselected on its host', () => {
    const id = tab()?.id ?? '';
    const paneId = leaves(tree())[0]?.paneId;
    requestSplit(id, 'row');
    expect(usePanesStore.getState().picker).toEqual({ tabId: id, paneId, dir: 'row', hostId: 'a' });
  });

  it('a chosen host becomes a second pane, which takes the focus', () => {
    const id = tab()?.id ?? '';
    requestSplit(id, 'row');
    completeSplit('b');
    expect(hosts()).toEqual(['a', 'b']);
    expect(tree()).toMatchObject({ kind: 'split', dir: 'row', ratio: 0.5 });
    expect(focusedPaneOf(id, tree())).toBe(leaves(tree())[1]?.paneId);
    expect(usePanesStore.getState().picker).toBeUndefined();
  });

  it('cancelling leaves the tab as it was', () => {
    const id = tab()?.id ?? '';
    const before = tree();
    requestSplit(id, 'column');
    cancelSplit();
    expect(tree()).toBe(before);
    expect(usePanesStore.getState().picker).toBeUndefined();
  });

  it('refuses, with a toast, a split that leaves a half too narrow or too short', () => {
    const id = tab()?.id ?? '';
    const paneId = leaves(tree())[0]?.paneId ?? '';
    notePaneSize(paneId, { cols: 78, rows: 8 });
    requestSplit(id, 'row');
    expect(usePanesStore.getState().picker).toBeUndefined();
    expect(toast).toHaveBeenLastCalledWith('Too narrow to split: each half needs 40 columns');
    requestSplit(id, 'column');
    expect(usePanesStore.getState().picker).toBeUndefined();
    expect(toast).toHaveBeenLastCalledWith('Too short to split: each half needs 5 rows');
  });

  it('refuses a split past the most panes a tab holds', () => {
    const id = tab()?.id ?? '';
    let node = tree();
    while (leaves(node).length < MAX_PANES) node = split(node, leaves(node)[0]?.paneId ?? '', 'row', 'a');
    useEditorsStore.setState({ tabs: useEditorsStore.getState().tabs.map((t) => ({ ...t, panes: node })) });
    requestSplit(id, 'row');
    expect(usePanesStore.getState().picker).toBeUndefined();
    expect(toast).toHaveBeenLastCalledWith('A tab holds at most 12 panes');
  });
});

describe('focus and close', () => {
  const twoPanes = (): string => {
    const id = tab()?.id ?? '';
    requestSplit(id, 'row');
    completeSplit('b');
    return id;
  };

  it('moves to the neighbouring pane, and stays put at the edge', () => {
    const id = twoPanes();
    const [left, right] = leaves(tree()).map((leaf) => leaf.paneId);
    moveFocus('left');
    expect(focusedPaneOf(id, tree())).toBe(left);
    moveFocus('left');
    expect(focusedPaneOf(id, tree())).toBe(left);
    moveFocus('right');
    expect(focusedPaneOf(id, tree())).toBe(right);
  });

  it('closing a pane hands its space to the sibling, which takes the focus', () => {
    const id = twoPanes();
    const [left, right] = leaves(tree()).map((leaf) => leaf.paneId);
    closePane(id, right ?? '');
    expect(tree()).toMatchObject({ kind: 'pane', paneId: left, hostId: 'a' });
    expect(focusedPaneOf(id, tree())).toBe(left);
  });

  it('closing the last pane closes the tab', () => {
    const id = tab()?.id ?? '';
    closePane(id, leaves(tree())[0]?.paneId ?? '');
    expect(useEditorsStore.getState().tabs).toEqual([]);
  });
});

describe('open in new tab', () => {
  it('opens another tab for a host that already has one', () => {
    openInNewTab('a');
    const terminals = useEditorsStore.getState().tabs.filter((t) => t.kind === 'ssh-terminal');
    expect(terminals).toHaveLength(2);
    expect(useEditorsStore.getState().activeId).toBe(terminals[1]?.id);
  });
});
