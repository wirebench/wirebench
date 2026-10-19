/**
 * The explorer's drag-and-drop rules, kept free of React and the stores so they can be tested.
 *
 * Under an API or folder the tree shows folders first, then requests, and `react-arborist` hands
 * over a drop `index` into that combined list, counted before anything is removed. Main's
 * `moveNode` instead takes an index into the one kind's own list, counted after the moved node is
 * pulled out. This module translates between the two.
 */
import { explorerRole } from '../../kinds/index.js';
import type { ExplorerNode, ExplorerNodeKind } from './tree-nodes.js';

/**
 * A folder or webhook item, or a request its kind marks movable within its API (spec §6.1): one
 * that moves within its container.
 */
function isMovable(node: ExplorerNode): boolean {
  return (
    node.kind === 'folder' ||
    node.kind === 'webhook-folder' ||
    node.kind === 'webhook-request' ||
    explorerRole(node.kind)?.movable === true
  );
}

/**
 * An API row of any kind (#701): dragged among its project's containers to reorder them, or onto
 * another project's row to move there.
 */
export function isContainerRow(node: ExplorerNode | undefined): boolean {
  return node !== undefined && explorerRole(node.kind)?.container === true;
}

/** The rows under a project that follow its containers, each with an ordering of its own. */
const PROJECT_GROUP_KINDS: ReadonlySet<ExplorerNodeKind> = new Set([
  'webhook-collection',
  'sequences',
  'mocks',
  'values',
]);

const isWebhookKind = (kind: string): boolean => kind === 'webhook-folder' || kind === 'webhook-request';

const isFolderKind = (kind: string): boolean => kind === 'folder' || kind === 'webhook-folder';

/** One `moveNode` call: where one dragged node goes, in its kind's list under the target parent. */
export interface PlannedMove {
  readonly entityId: string;
  readonly kind: ExplorerNodeKind;
  readonly index: number;
}

function movableId(node: ExplorerNode): string | undefined {
  if (!isMovable(node)) return undefined;
  return isFolderKind(node.kind) ? node.folderId : node.requestId;
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
  // Each movable kind's own list under the parent, and the node each dragged one goes after.
  const lists = new Map<ExplorerNodeKind, string[]>();
  const listOf = (kind: ExplorerNodeKind): string[] => {
    const list = lists.get(kind) ?? [];
    lists.set(kind, list);
    return list;
  };
  const anchors = new Map<ExplorerNodeKind, string>();

  children.forEach((child, position) => {
    const id = movableId(child);
    if (id === undefined) return;
    listOf(child.kind).push(id);
    if (position < index && !draggedIds.has(id)) {
      anchors.set(child.kind, id);
    }
  });

  const plan: PlannedMove[] = [];
  for (const node of dragged) {
    const entityId = movableId(node);
    if (entityId === undefined) continue;
    const list = listOf(node.kind);
    const current = list.indexOf(entityId);
    if (current !== -1) list.splice(current, 1);

    const anchor = anchors.get(node.kind);
    const target = anchor === undefined ? 0 : list.indexOf(anchor) + 1;
    list.splice(target, 0, entityId);
    anchors.set(node.kind, entityId);
    plan.push({ entityId, kind: node.kind, index: target });
  }
  return plan;
}

/** Where an API row dropped on a project goes: which project, and the API it goes before. */
export interface ContainerDrop {
  readonly apiId: string;
  readonly targetProjectId: string;
  /** The API it lands before; absent, it goes after the project's last API. */
  readonly beforeApiId?: string;
}

/**
 * The move an API row dropped at `index` among a project's `children` makes. Only API rows take
 * part in the ordering: a drop next to an interface or a placeholder lands at the next API after
 * it, so interfaces keep the places they had. `undefined` for a drag that is not an API row.
 */
export function planContainerDrop(
  project: ExplorerNode,
  children: readonly ExplorerNode[],
  dragged: ExplorerNode,
  index: number,
): ContainerDrop | undefined {
  if (!isContainerRow(dragged) || dragged.apiId === undefined || project.projectId === undefined) return undefined;
  const before = children
    .slice(index)
    .find((child) => isContainerRow(child) && child.apiId !== undefined && child.apiId !== dragged.apiId);
  return {
    apiId: dragged.apiId,
    targetProjectId: project.projectId,
    ...(before?.apiId !== undefined ? { beforeApiId: before.apiId } : {}),
  };
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
 * Whether the tree refuses an API row's drop (#701). It drops only on a project: its own, among the
 * containers (not past them, among the Sequences or Mocks groups), or another one that is open,
 * anywhere. A project still loading, or whose folder is missing, takes nothing.
 */
function isContainerDropDisabled({ parent, children, index, sameProject }: DropCandidate): boolean {
  if (parent?.kind !== 'project' || parent.loading === true) return true;
  if (children.some((child) => child.kind === 'project-missing')) return true;
  if (!sameProject) return false;
  const containerCount = children.filter((child) => !PROJECT_GROUP_KINDS.has(child.kind)).length;
  return index > containerCount;
}

/**
 * Whether the tree should refuse a drop. An API row moves only among projects' containers (see
 * {@link isContainerDropDisabled}). A request or folder moves only within its own API,
 * never into another API or project; a webhook item or folder only within its own project's
 * webhook collection, and nothing else into it. A folder never moves into itself or its own
 * subtree. Folders drop only among folders, and requests only among requests.
 */
export function isDropDisabled({ parent, children, dragged, index, sameProject, ancestors }: DropCandidate): boolean {
  if (isContainerRow(dragged))
    return isContainerDropDisabled({ parent, children, dragged, index, sameProject, ancestors });
  if (dragged === undefined || !isMovable(dragged) || parent === undefined || !sameProject) return true;
  if (isWebhookKind(dragged.kind)) {
    // The collection has one per project, so `sameProject` already pins it down.
    if (parent.kind !== 'webhook-collection' && parent.kind !== 'webhook-folder') return true;
  } else {
    if (explorerRole(parent.kind)?.dropTarget !== true && parent.kind !== 'folder') {
      return true;
    }
    if (parent.apiId !== dragged.apiId) return true;
  }

  if (isFolderKind(dragged.kind)) {
    const intoItself = [parent, ...ancestors].some(
      (node) => isFolderKind(node.kind) && node.folderId === dragged.folderId,
    );
    if (intoItself) return true;
  }

  const folderCount = children.filter((child) => isFolderKind(child.kind)).length;
  if (isFolderKind(dragged.kind)) return index > folderCount;
  return index < folderCount;
}
