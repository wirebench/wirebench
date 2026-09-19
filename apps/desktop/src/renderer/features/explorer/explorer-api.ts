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

/** The explorer row kinds a rename can be started on by id, with the prefix their tree ids carry. */
export type RenamableNodeKind =
  'api' | 'folder' | 'rest-request' | 'grpc-api' | 'grpc-request' | 'ws-api' | 'ws-request';

const NODE_ID_PREFIX: Readonly<Record<RenamableNodeKind, string>> = {
  api: 'api',
  folder: 'folder',
  'rest-request': 'rest',
  'grpc-api': 'grpc-api',
  'grpc-request': 'grpc',
  'ws-api': 'ws-api',
  'ws-request': 'ws',
};

/** Enters inline edit mode for an API, folder, REST request or gRPC row. */
export function startRenamingNode(kind: RenamableNodeKind, id: string): void {
  startRenaming(`${NODE_ID_PREFIX[kind]}:${id}`);
}

/** Enters inline edit mode for a project root, if the tree is mounted and the node exists. */
export function startRenamingProject(projectId: string): void {
  startRenaming(`proj:${projectId}`);
}

function startRenaming(nodeId: string): void {
  const trigger = () => {
    const tree = treeApi;
    if (tree === null) {
      return;
    }
    void tree.get(nodeId)?.edit();
  };

  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(trigger);
  } else {
    trigger();
  }
}
