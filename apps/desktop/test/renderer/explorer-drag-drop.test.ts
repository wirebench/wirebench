import { describe, expect, it } from 'vitest';
import { isDropDisabled, planMoves } from '../../src/renderer/features/explorer/drag-drop.js';
import type { ExplorerNode } from '../../src/renderer/features/explorer/tree-nodes.js';

const api: ExplorerNode = { id: 'api:api-1', kind: 'api', label: 'Api', apiId: 'api-1' };
const otherApi: ExplorerNode = { id: 'api:api-2', kind: 'api', label: 'Other', apiId: 'api-2' };

function folder(id: string, apiId = 'api-1'): ExplorerNode {
  return { id: `folder:${id}`, kind: 'folder', label: id, folderId: id, apiId };
}

function request(id: string, apiId = 'api-1'): ExplorerNode {
  return { id: `rest:${id}`, kind: 'rest-request', label: id, requestId: id, apiId };
}

/**
 * Applies a plan the way main's `moveNode` does: pull the node out of its kind's list, then splice
 * it back in at the clamped index. Returns the parent's children, folders first.
 */
function apply(children: readonly ExplorerNode[], plan: ReturnType<typeof planMoves>): string[] {
  const folders = children.filter((c) => c.kind === 'folder').map((c) => restId(c));
  const requests = children.filter((c) => c.kind === 'rest-request').map((c) => restId(c));
  for (const move of plan) {
    const list = folders.includes(move.entityId) || move.kind === 'folder' ? folders : requests;
    const at = list.indexOf(move.entityId);
    if (at !== -1) list.splice(at, 1);
    list.splice(Math.max(0, Math.min(move.index, list.length)), 0, move.entityId);
  }
  return [...folders, ...requests];
}

function restId(node: ExplorerNode): string {
  return node.kind === 'folder' ? (node.folderId ?? '') : (node.requestId ?? '');
}

describe('planMoves', () => {
  it('moves a request down within the same parent: 0 dropped before 2 lands at 1', () => {
    const children = [request('a'), request('b'), request('c')];
    const plan = planMoves(children, [request('a')], 2);

    expect(plan).toEqual([{ entityId: 'a', kind: 'rest-request', index: 1 }]);
    expect(apply(children, plan)).toEqual(['b', 'a', 'c']);
  });

  it('moves a request up within the same parent', () => {
    const children = [request('a'), request('b'), request('c')];

    expect(apply(children, planMoves(children, [request('c')], 0))).toEqual(['c', 'a', 'b']);
  });

  it('offsets request indices past the folders', () => {
    const children = [folder('f1'), request('a'), request('b')];

    expect(apply(children, planMoves(children, [request('a')], 3))).toEqual(['f1', 'b', 'a']);
  });

  it('keeps the dragged order for a multi-drag moving down', () => {
    const children = [request('a'), request('b'), request('c'), request('d'), request('e')];
    const plan = planMoves(children, [request('a'), request('b')], 4);

    expect(apply(children, plan)).toEqual(['c', 'd', 'a', 'b', 'e']);
  });

  it('keeps the dragged order for a multi-drag that straddles the drop index', () => {
    const children = [request('a'), request('b'), request('c'), request('d'), request('e')];

    // `d` sits after the drop point and `a` before it: both end up together, in drag order.
    expect(apply(children, planMoves(children, [request('d'), request('a')], 2))).toEqual(['b', 'd', 'a', 'c', 'e']);
  });

  it('keeps the dragged order for a multi-drag moving up, including nodes from another parent', () => {
    const children = [request('a'), request('b'), request('c')];

    expect(apply(children, planMoves(children, [request('c'), request('x')], 1))).toEqual(['a', 'c', 'x', 'b']);
  });

  it('moves folders within the folder zone', () => {
    const children = [folder('f1'), folder('f2'), folder('f3'), request('a')];

    expect(apply(children, planMoves(children, [folder('f1')], 3))).toEqual(['f2', 'f3', 'f1', 'a']);
  });
});

describe('isDropDisabled', () => {
  const base = { sameProject: true, ancestors: [] as readonly ExplorerNode[] };

  it('allows a request among the requests of its own API', () => {
    const children = [folder('f1'), request('a'), request('b')];
    expect(isDropDisabled({ ...base, parent: api, children, dragged: request('a'), index: 3 })).toBe(false);
  });

  it('disables a request dropped among folders', () => {
    const children = [folder('f1'), folder('f2'), request('a')];
    expect(isDropDisabled({ ...base, parent: api, children, dragged: request('a'), index: 1 })).toBe(true);
  });

  it('disables a folder dropped among requests', () => {
    const children = [folder('f1'), request('a'), request('b')];
    expect(isDropDisabled({ ...base, parent: api, children, dragged: folder('f1'), index: 2 })).toBe(true);
  });

  it('disables a drop into another API', () => {
    expect(isDropDisabled({ ...base, parent: otherApi, children: [], dragged: request('a', 'api-1'), index: 0 })).toBe(
      true,
    );
  });

  it('disables a drop into another project', () => {
    expect(
      isDropDisabled({ ...base, sameProject: false, parent: api, children: [], dragged: request('a'), index: 0 }),
    ).toBe(true);
  });

  it('disables a folder dropped into itself or its own descendant', () => {
    const f1 = folder('f1');
    const inner = folder('inner');
    expect(isDropDisabled({ ...base, parent: f1, children: [], dragged: f1, index: 0 })).toBe(true);
    expect(
      isDropDisabled({ ...base, parent: inner, ancestors: [inner, f1, api], children: [], dragged: f1, index: 0 }),
    ).toBe(true);
  });

  it('disables dragging anything but requests and folders, or dropping onto anything but APIs and folders', () => {
    expect(isDropDisabled({ ...base, parent: api, children: [], dragged: api, index: 0 })).toBe(true);
    expect(isDropDisabled({ ...base, parent: request('b'), children: [], dragged: request('a'), index: 0 })).toBe(true);
    expect(isDropDisabled({ ...base, parent: undefined, children: [], dragged: request('a'), index: 0 })).toBe(true);
  });
});
