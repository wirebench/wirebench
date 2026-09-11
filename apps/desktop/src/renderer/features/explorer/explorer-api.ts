import type { TreeApi } from 'react-arborist';
import type { ExplorerNode } from './tree-nodes.js';

/**
 * A small registry the explorer view publishes its `react-arborist` tree handle into, so
 * commands/actions outside the component tree (the palette) can drive it — e.g. entering
 * inline rename mode for a node selected via keyboard rather than a right-click.
 */
let treeApi: TreeApi<ExplorerNode> | null = null;

/** Called by the explorer view whenever its tree mounts/unmounts (`null` while unmounted). */
export function registerExplorerTree(api: TreeApi<ExplorerNode> | null): void {
  treeApi = api;
}

/** The currently mounted explorer tree's `react-arborist` handle, if any. */
export function getExplorerTree(): TreeApi<ExplorerNode> | null {
  return treeApi;
}

/** Enters inline edit mode for a request node, if the tree is mounted and the node exists. */
export function startRenamingRequest(requestId: string): void {
  startRenaming(`req:${requestId}`);
}

/** Enters inline edit mode for a project root, if the tree is mounted and the node exists. */
export function startRenamingProject(projectId: string): void {
  startRenaming(`proj:${projectId}`);
}

function startRenaming(nodeId: string): void {
  const tree = treeApi;
  if (tree === null) {
    return;
  }
  void tree.get(nodeId)?.edit();
}
