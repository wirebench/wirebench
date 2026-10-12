import { describe, expect, it } from 'vitest';
import {
  close,
  hasHost,
  leaves,
  MAX_PANES,
  neighbour,
  onePane,
  setRatio,
  split,
  titleOf,
  type PaneNode,
} from '../../src/renderer/features/ssh/panes/pane-tree.js';

const pane = (paneId: string, hostId = 'h'): PaneNode => ({ kind: 'pane', paneId, hostId });

/** p1 | p2 over p3 | p4, every split even. */
const GRID: PaneNode = {
  kind: 'split',
  dir: 'column',
  ratio: 0.5,
  a: { kind: 'split', dir: 'row', ratio: 0.5, a: pane('p1'), b: pane('p2') },
  b: { kind: 'split', dir: 'row', ratio: 0.5, a: pane('p3'), b: pane('p4') },
};

describe('the pane tree', () => {
  it('starts as one pane on the host, with a fresh id each time', () => {
    const one = onePane('db-1');
    expect(one).toMatchObject({ kind: 'pane', hostId: 'db-1' });
    expect(leaves(one)).toHaveLength(1);
    expect(leaves(onePane('db-1'))[0]?.paneId).not.toBe(leaves(one)[0]?.paneId);
  });

  it('lists its leaves in reading order', () => {
    expect(leaves(GRID).map((l) => l.paneId)).toEqual(['p1', 'p2', 'p3', 'p4']);
  });

  it('split puts a new pane on the host after the one split, and close gives back the original shape', () => {
    const root = pane('p1', 'a');
    const two = split(root, 'p1', 'row', 'b');
    expect(two).toMatchObject({ kind: 'split', dir: 'row', ratio: 0.5, a: root, b: { kind: 'pane', hostId: 'b' } });
    const added = leaves(two)[1]?.paneId ?? '';
    expect(close(two, added)).toEqual(root);
    expect(close(two, 'p1')).toMatchObject({ kind: 'pane', paneId: added });
  });

  it('closing a pane deep in the tree lets its sibling take the space', () => {
    expect(close(GRID, 'p2')).toEqual({ ...GRID, a: pane('p1') });
  });

  it('closing the last pane leaves nothing', () => {
    expect(close(pane('p1'), 'p1')).toBeUndefined();
  });

  it('leaves the tree as it is for a pane it does not hold', () => {
    expect(split(GRID, 'nope', 'row', 'h')).toBe(GRID);
    expect(close(GRID, 'nope')).toBe(GRID);
  });

  it('refuses a split past MAX_PANES', () => {
    let root = pane('p0');
    for (let i = 1; i < MAX_PANES; i++) root = split(root, 'p0', 'row', 'h');
    expect(leaves(root)).toHaveLength(MAX_PANES);
    expect(() => split(root, 'p0', 'column', 'h')).toThrow(/12/);
  });

  it('setRatio follows the path and clamps to 0.1–0.9', () => {
    const wide = setRatio(GRID, ['a'], 0.95);
    expect(wide).toMatchObject({ ratio: 0.5, a: { ratio: 0.9 }, b: { ratio: 0.5 } });
    expect(setRatio(GRID, [], 0)).toMatchObject({ ratio: 0.1 });
    expect(setRatio(GRID, ['b'], 0.3)).toMatchObject({ b: { ratio: 0.3 } });
    // A path that ends on a pane names no divider.
    expect(setRatio(GRID, ['a', 'a'], 0.3)).toBe(GRID);
  });

  it('finds the neighbour in each direction of a 2×2 grid', () => {
    expect(neighbour(GRID, 'p1', 'right')).toBe('p2');
    expect(neighbour(GRID, 'p1', 'down')).toBe('p3');
    expect(neighbour(GRID, 'p4', 'left')).toBe('p3');
    expect(neighbour(GRID, 'p4', 'up')).toBe('p2');
    expect(neighbour(GRID, 'p1', 'left')).toBeUndefined();
    expect(neighbour(GRID, 'p1', 'up')).toBeUndefined();
    expect(neighbour(GRID, 'p4', 'right')).toBeUndefined();
  });

  it('picks the neighbour that overlaps the pane most', () => {
    // p1 on the left, the right half split into p2 (top 30%) and p3 (bottom 70%).
    const root: PaneNode = {
      kind: 'split',
      dir: 'row',
      ratio: 0.5,
      a: pane('p1'),
      b: { kind: 'split', dir: 'column', ratio: 0.3, a: pane('p2'), b: pane('p3') },
    };
    expect(neighbour(root, 'p1', 'right')).toBe('p3');
    expect(neighbour(root, 'p2', 'left')).toBe('p1');
  });

  it('knows which hosts it has panes on', () => {
    const root = split(pane('p1', 'a'), 'p1', 'column', 'b');
    expect(hasHost(root, 'a')).toBe(true);
    expect(hasHost(root, 'b')).toBe(true);
    expect(hasHost(root, 'c')).toBe(false);
  });
});

describe('a terminal tab title', () => {
  const names: Record<string, string> = { a: 'db-1', b: 'db-2' };
  const nameOf = (hostId: string): string | undefined => names[hostId];

  it('is the host name for one pane, and counts the rest for more', () => {
    expect(titleOf(pane('p1', 'a'), nameOf)).toBe('db-1');
    expect(titleOf({ ...GRID, a: { ...GRID.a, a: pane('p1', 'a') } } as PaneNode, nameOf)).toBe('db-1 + 3');
    expect(titleOf(pane('p1', 'gone'), nameOf)).toBeUndefined();
  });
});
