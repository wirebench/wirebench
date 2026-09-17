/**
 * The explorer's drag-and-drop rules, kept free of React and the stores so they can be tested.
 *
 * Under an API or folder the tree shows folders first, then requests, and `react-arborist` hands
 * over a drop `index` into that combined list, counted before anything is removed. Main's
 * `moveNode` instead takes an index into the one kind's own list, counted after the moved node is
 * pulled out. This module translates between the two.
 */
import type { ExplorerNode } from './tree-nodes.js';

/** A folder or request movable within an API (REST or gRPC). */
type MovableKind = 'folder' | 'rest-request' | 'grpc-request';

function isMovable(node: ExplorerNode): node is ExplorerNode & { readonly kind: MovableKind } {
  return node.kind === 'folder' || node.kind === 'rest-request' || node.kind === 'grpc-request';
}

/** One `moveNode` call: where one dragged node goes, in its kind's list under the target parent. */
export interface PlannedMove {
  readonly entityId: string;
  readonly kind: MovableKind;
  readonly index: number;
}

function movableId(node: ExplorerNode): string | undefined {
  if (node.kind === 'folder') return node.folderId;
  if (node.kind === 'rest-request' || node.kind === 'grpc-request') return node.requestId;
  return undefined;
}

/**
 * The `moveNode` calls, to be run in order and each awaited, that put `dragged` together at `index`
 * under a parent whose current children are `children`, keeping the drag order.
 *
 * The plan simulates each move rather than adjusting the indices arithmetically. Once one node has
 * moved, the positions of the nodes still to move have shifted, and a stale index would scatter a
 * multi-drag. Each node is placed right after the one that should come before it: the previous
 * dragged node of its kind, or else the last node of its kind that stays put before the drop point.
 */
export function planMoves(
  children: readonly ExplorerNode[],
  dragged: readonly ExplorerNode[],
  index: number,
): PlannedMove[] {
  const draggedIds = new Set(dragged.map(movableId).filter((id): id is string => id !== undefined));
  const lists: Record<MovableKind, string[]> = { folder: [], 'rest-request': [], 'grpc-request': [] };
  const anchors: Record<MovableKind, string | undefined> = {
    folder: undefined,
    'rest-request': undefined,
    'grpc-request': undefined,
  };

  children.forEach((child, position) => {
    const id = movableId(child);
    if (id === undefined || !isMovable(child)) return;
    lists[child.kind].push(id);
    if (position < index && !draggedIds.has(id)) {
      anchors[child.kind] = id;
    }
  });

  const plan: PlannedMove[] = [];
  for (const node of dragged) {
    const entityId = movableId(node);
    if (entityId === undefined || !isMovable(node)) continue;
    const list = lists[node.kind];
    const current = list.indexOf(entityId);
    if (current !== -1) list.splice(current, 1);

    const anchor = anchors[node.kind];
    const target = anchor === undefined ? 0 : list.indexOf(anchor) + 1;
    list.splice(target, 0, entityId);
    anchors[node.kind] = entityId;
    plan.push({ entityId, kind: node.kind, index: target });
  }
  return plan;
}

export interface DropCandidate {
  /** The node being dropped into. */
  readonly parent: ExplorerNode | undefined;
  /** The parent's current children, folders first. */
  readonly children: readonly ExplorerNode[];
  /** The first dragged node, which decides the drop. */
  readonly dragged: ExplorerNode | undefined;
  /** The drop position in `children`. */
  readonly index: number;
  /** Whether `parent` and `dragged` live in the same project. */
  readonly sameProject: boolean;
  /** `parent` and every node above it, nearest first. */
  readonly ancestors: readonly ExplorerNode[];
}

/**
 * Whether the tree should refuse a drop. A request or folder moves only within its own API,
 * never into another API or project. A folder never moves into itself or its own subtree. Folders
 * drop only among folders, and requests only among requests.
 */
export function isDropDisabled({ parent, children, dragged, index, sameProject, ancestors }: DropCandidate): boolean {
  if (dragged === undefined || !isMovable(dragged)) return true;
  if (parent === undefined || (parent.kind !== 'api' && parent.kind !== 'grpc-api' && parent.kind !== 'folder')) {
    return true;
  }
  if (!sameProject || parent.apiId !== dragged.apiId) return true;

  if (dragged.kind === 'folder') {
    const intoItself = [parent, ...ancestors].some(
      (node) => node.kind === 'folder' && node.folderId === dragged.folderId,
    );
    if (intoItself) return true;
  }

  const folderCount = children.filter((child) => child.kind === 'folder').length;
  if (dragged.kind === 'folder') return index > folderCount;
  return index < folderCount;
}
