import { beforeEach, describe, expect, it, vi } from 'vitest';

vi.mock('../../src/renderer/state/ipc-client.js', () => ({ ipc: () => ({}) }));
import { useHostsStore } from '../../src/renderer/features/ssh/hosts-store.js';
import { useLayoutsStore } from '../../src/renderer/features/ssh/panes/layouts-store.js';
import {
  fromLayoutNode,
  layoutHosts,
  layoutPaneCount,
  openLayout,
  savableTreeOf,
  terminalTitleOf,
  toLayoutNode,
} from '../../src/renderer/features/ssh/panes/open-layout.js';
import { leaves, type PaneNode } from '../../src/renderer/features/ssh/panes/pane-tree.js';
import { useEditorsStore } from '../../src/renderer/state/editors.js';
import { quickOpenLayoutEntries } from '../../src/renderer/shell/quick-open.js';
import type { LayoutNodeWire, LayoutWire } from '@wirebench/wire/layout-wire';

const pane = (paneId: string, hostId: string): PaneNode => ({ kind: 'pane', paneId, hostId });
/** db-1 | (db-2 over db-3), the first split at 0.3. */
const TREE: PaneNode = {
  kind: 'split',
  dir: 'row',
  ratio: 0.3,
  a: pane('p1', 'db-1'),
  b: { kind: 'split', dir: 'column', ratio: 0.5, a: pane('p2', 'db-2'), b: pane('p3', 'db-3') },
};
const SAVED: LayoutNodeWire = {
  kind: 'split',
  dir: 'row',
  ratio: 0.3,
  a: { kind: 'pane', host: 'db-1' },
  b: { kind: 'split', dir: 'column', ratio: 0.5, a: { kind: 'pane', host: 'db-2' }, b: { kind: 'pane', host: 'db-3' } },
};
const PROD: LayoutWire = { id: 'L1', name: 'Prod databases', root: SAVED };

const host = (id: string, name = id) =>
  ({
    id,
    name,
    address: `${id}.example`,
    tags: [],
    path: [],
    protected: { value: false, from: 'default' },
    ssh: {},
    forwards: [],
  }) as never;

beforeEach(() => {
  useEditorsStore.getState().reset();
  useLayoutsStore.setState({ layouts: [], loaded: true });
  useHostsStore.setState({ resolved: [host('db-1'), host('db-2'), host('db-3')], loaded: true, panes: {} });
});

describe('layout trees', () => {
  it('saves a tab’s tree by host id with its ratios, and opens it back with fresh pane ids', () => {
    expect(toLayoutNode(TREE)).toEqual(SAVED);
    const opened = fromLayoutNode(SAVED);
    expect(toLayoutNode(opened)).toEqual(SAVED);
    expect(leaves(opened).map((leaf) => leaf.hostId)).toEqual(['db-1', 'db-2', 'db-3']);
    expect(leaves(opened).map((leaf) => leaf.paneId)).not.toContain('p1');
    expect(new Set(leaves(opened).map((leaf) => leaf.paneId)).size).toBe(3);
  });

  it('leaves out a pane whose host is refused; its sibling takes the space', () => {
    expect(toLayoutNode(TREE, (id) => id !== 'db-3')).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.3,
      a: { kind: 'pane', host: 'db-1' },
      b: { kind: 'pane', host: 'db-2' },
    });
    expect(toLayoutNode(TREE, () => false)).toBeUndefined();
  });

  it('names each host once and counts the panes', () => {
    expect(layoutHosts({ kind: 'split', dir: 'row', ratio: 0.5, a: SAVED, b: { kind: 'pane', host: 'db-1' } })).toEqual(
      ['db-1', 'db-2', 'db-3'],
    );
    expect(layoutPaneCount(SAVED)).toBe(3);
  });
});

describe('openLayout', () => {
  it('opens one tab titled by the layout, holding its tree and linked to it', () => {
    openLayout(PROD);
    const { tabs, activeId } = useEditorsStore.getState();
    expect(tabs).toHaveLength(1);
    const tab = tabs[0]!;
    expect(activeId).toBe(tab.id);
    expect(tab).toMatchObject({ kind: 'ssh-terminal', title: 'Prod databases', layoutId: 'L1' });
    expect(tab.id).toMatch(/^ssh-terminal:/);
    expect(toLayoutNode(tab.panes!)).toEqual(SAVED);
  });

  it('a layout naming a host deleted since saves again without it (review focus 5)', () => {
    useHostsStore.setState({ resolved: [host('db-1'), host('db-2')] });
    openLayout(PROD);
    const tab = useEditorsStore.getState().tabs[0]!;
    expect(savableTreeOf(tab.id)).toEqual({
      kind: 'split',
      dir: 'row',
      ratio: 0.3,
      a: { kind: 'pane', host: 'db-1' },
      b: { kind: 'pane', host: 'db-2' },
    });
  });
});

describe('terminal tab titles', () => {
  const nameOf = (id: string) => (id === 'db-1' ? 'db-1' : undefined);
  it('a tab never saved is titled by its first host and the count', () => {
    expect(terminalTitleOf({ panes: TREE }, [PROD], nameOf)).toBe('db-1 + 2');
  });
  it('a tab from a layout carries the layout’s name, and falls back once the layout is deleted', () => {
    expect(terminalTitleOf({ panes: TREE, layoutId: 'L1' }, [PROD], nameOf)).toBe('Prod databases');
    expect(terminalTitleOf({ panes: TREE, layoutId: 'L1' }, [], nameOf)).toBe('db-1 + 2');
  });
});

describe('quick-open layout rows', () => {
  it('list each layout with its hosts and pane count', () => {
    expect(quickOpenLayoutEntries([PROD], (id) => id.toUpperCase())).toEqual([
      {
        key: 'layout:L1',
        kind: 'layout',
        label: 'Prod databases',
        detail: 'DB-1, DB-2, DB-3 · 3 panes',
        value: 'Prod databases DB-1 DB-2 DB-3',
        layoutId: 'L1',
      },
    ]);
  });
});
