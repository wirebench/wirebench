import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { TreeApi } from 'react-arborist';
import { registerExplorerTree, startRenamingNode } from '../../src/renderer/features/explorer/explorer-api.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { DEFAULT_UI_STATE } from '../../src/renderer/state/ui-state.js';

/** A stand-in for the tree handle the Explorer view registers once it mounts. */
function fakeTree() {
  const edit = vi.fn();
  const node = { isSelected: false, edit, focus: vi.fn() };
  const get = vi.fn(() => node);
  const tree = { openParents: vi.fn(), get, select: vi.fn() };
  return { tree: tree as unknown as TreeApi<ExplorerNode>, edit, get };
}

describe('a new item from the palette while another sidebar view shows (#914)', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
    // Frames run on a timer, so the tree can mount between them.
    vi.stubGlobal('requestAnimationFrame', (run: FrameRequestCallback) => setTimeout(() => run(0), 0));
  });
  afterEach(() => {
    registerExplorerTree(null);
    vi.unstubAllGlobals();
  });

  it('brings the Explorer into the sidebar and starts the rename once its tree mounts', async () => {
    useUiStore.getState().setSidebarView('history');
    registerExplorerTree(null);
    const { tree, edit, get } = fakeTree();

    startRenamingNode('rest-request', 'r1');

    expect(useUiStore.getState().sidebar.view).toBe('explorer');
    expect(useUiStore.getState().sidebar.visible).toBe(true);
    // The Explorer view mounts its tree a few frames later.
    await new Promise((resolve) => setTimeout(resolve, 5));
    registerExplorerTree(tree);
    await vi.waitFor(() => {
      expect(edit).toHaveBeenCalled();
    });
    expect(get).toHaveBeenCalledWith('rest:r1');
  });

  it('shows a folded-away sidebar, and leaves the Explorer in front when it already is', async () => {
    const { tree, edit } = fakeTree();
    registerExplorerTree(tree);
    startRenamingNode('folder', 'f1');
    expect(useUiStore.getState().sidebar).toMatchObject({ view: 'explorer', visible: true });
    await vi.waitFor(() => {
      expect(edit).toHaveBeenCalledTimes(1);
    });

    useUiStore.getState().showSidebarView('explorer'); // folds it away
    expect(useUiStore.getState().sidebar.visible).toBe(false);
    startRenamingNode('folder', 'f1');
    expect(useUiStore.getState().sidebar).toMatchObject({ view: 'explorer', visible: true });
  });
});
