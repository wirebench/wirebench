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
  | 'api'
  | 'folder'
  | 'rest-request'
  | 'grpc-api'
  | 'grpc-request'
  | 'ws-api'
  | 'ws-request'
  | 'mcp-api'
  | 'mcp-request'
  | 'webhook-folder'
  | 'webhook-request'
  | 'sequence'
  | 'mock';

const NODE_ID_PREFIX: Readonly<Record<RenamableNodeKind, string>> = {
  api: 'api',
  folder: 'folder',
  'rest-request': 'rest',
  'grpc-api': 'grpc-api',
  'grpc-request': 'grpc',
  'ws-api': 'ws-api',
  'ws-request': 'ws',
  'mcp-api': 'mcp-api',
  'mcp-request': 'mcp',
  'webhook-folder': 'webhook-folder',
  'webhook-request': 'webhook-request',
  sequence: 'sequence',
  mock: 'mock',
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
  revealNode(nodeId, { focus: true, rename: true });
}

/** How many frames {@link revealNode} waits for a row that is not in the tree yet (one just created). */
const REVEAL_FRAMES = 30;

/** What {@link revealNode} does once the row is shown. */
export interface RevealOptions {
  /** Move keyboard focus to the row; off, focus stays where it is (in an editor, say). */
  readonly focus?: boolean;
  /** Start an inline rename of the row. */
  readonly rename?: boolean;
}

/**
 * Unfolds a row's ancestors, selects it and scrolls it into view. A row that is not in the tree yet — one a
 * mutation has just created, before the tree re-rendered — is waited for, a frame at a time, and given up on
 * after {@link REVEAL_FRAMES}.
 */
export function revealNode(nodeId: string, options: RevealOptions = {}): void {
  let frames = 0;
  const attempt = (): void => {
    const tree = treeApi;
    if (tree === null) return;
    // A collapsed ancestor keeps the row out of the visible list, where `get` looks.
    tree.openParents(nodeId);
    const node = tree.get(nodeId);
    if (node === null) {
      frames += 1;
      if (frames < REVEAL_FRAMES) nextFrame(attempt);
      return;
    }
    if (!node.isSelected) tree.select(nodeId, { focus: options.focus === true });
    else if (options.focus === true) node.focus();
    if (options.rename === true) void node.edit();
  };
  nextFrame(attempt);
}

function nextFrame(run: () => void): void {
  if (typeof requestAnimationFrame === 'function') {
    requestAnimationFrame(run);
  } else {
    run();
  }
}
