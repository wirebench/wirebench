/**
 * What the Explorer does to its selection as a whole (#681): the palette's `explorer.*` tree commands,
 * the Delete and F2 keys and the multi-row context menu all come through here, so one selection of
 * several rows is deleted through one confirm, duplicated once each and moved together.
 */
import type { NodeApi } from 'react-arborist';
import { showToast } from '../../components/toast.js';
import { entityIdOf, explorerDeletion, explorerRole, TAB_KINDS } from '../../kinds/index.js';
import { useEditorsStore } from '../../state/editors.js';
import { usePreferencesStore } from '../../state/preferences.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore, type PendingNodeDeletion } from '../../state/ui.js';
import { schedulesActions } from '../schedules/schedules-actions.js';
import { webhooksActions } from '../webhooks/webhooks-actions.js';
import { explorerActions } from './explorer-actions.js';
import { getExplorerTree, revealNode } from './explorer-api.js';
import { projectRowActions } from './project-actions.js';
import type { ExplorerNode } from './tree-nodes.js';

/** The row kinds that are one request: what **Duplicate** copies and **Delete N requests…** counts. */
export const REQUEST_ROW_KINDS: ReadonlySet<ExplorerNode['kind']> = new Set<ExplorerNode['kind']>([
  'request',
  'rest-request',
  'grpc-request',
  'ws-request',
  'mcp-request',
  'webhook-request',
]);

/** The row kinds **Duplicate** copies: every request, a sequence and a mock. */
export const DUPLICABLE_KINDS: ReadonlySet<ExplorerNode['kind']> = new Set<ExplorerNode['kind']>([
  ...REQUEST_ROW_KINDS,
  'sequence',
  'mock',
]);

/**
 * The deletion the explorer's confirm dialog carries out for `node`, or `undefined` for a row that is
 * deleted some other way (a project, an interface, a catch URL, a schedule) or not at all.
 */
export function pendingDeletionOf(node: ExplorerNode): PendingNodeDeletion | undefined {
  const pending = (kind: PendingNodeDeletion['kind'], id: string | undefined): PendingNodeDeletion | undefined =>
    id === undefined ? undefined : { kind, id, name: node.label, requestCount: 0 };
  switch (node.kind) {
    case 'api':
      return pending('api', node.apiId);
    case 'grpc-api':
      return pending('grpc-api', node.apiId);
    case 'ws-api':
      return pending('ws-api', node.apiId);
    case 'mcp-api':
      return pending('mcp-api', node.apiId);
    // A webhook folder/request is a REST folder/request on the wire (openapi-webhooks-import §3.1).
    case 'folder':
    case 'webhook-folder':
      return pending('folder', node.folderId);
    case 'rest-request':
    case 'webhook-request':
      return pending('rest-request', node.requestId);
    case 'grpc-request':
      return pending('grpc-request', node.requestId);
    case 'ws-request':
      return pending('ws-request', node.requestId);
    case 'mcp-request':
      return pending('mcp-request', node.requestId);
    case 'sequence':
      return pending('sequence', node.sequenceId);
    case 'mock':
      return pending('mock', node.mockId);
    default:
      return undefined;
  }
}

/** Carries out one confirmed deletion: the kind's own remover, or the store's for the shared kinds. */
export function runNodeDeletion(pending: PendingNodeDeletion): Promise<unknown> {
  const store = useProjectStore.getState();
  const { kind, id } = pending;
  const deletion = explorerDeletion(kind);
  if (deletion !== undefined) return deletion.remove(id);
  switch (kind) {
    case 'folder':
      return store.removeFolder(id);
    case 'sequence':
      return store.removeSequence(id);
    case 'mock':
      return store.removeMock(id);
    default:
      return Promise.reject(new Error(`Nothing deletes a ${kind}`));
  }
}

function reportDeleteFailure(error: unknown): void {
  showToast(error instanceof Error ? error.message : 'Delete failed');
}

/** Asks to delete one row the way its kind does: its own confirm, or none when Settings turned confirms off. */
function deleteOne(node: ExplorerNode): void {
  const role = explorerRole(node.kind);
  if (role !== undefined) {
    role.remove?.(node);
  } else if (node.kind === 'project' && node.projectId !== undefined) {
    projectRowActions.remove(node.projectId);
  } else if (node.kind === 'folder' || node.kind === 'webhook-folder') {
    explorerActions.removeFolder(node.folderId);
  } else if (node.kind === 'webhook-request') {
    explorerActions.deleteRestRequest(node.requestId);
  } else if (node.kind === 'catch-url' && node.canEdit === true && node.hookId !== undefined) {
    webhooksActions.confirm('delete', node.hookId);
  } else if (node.kind === 'schedule' && node.canEdit === true && node.scheduleId !== undefined) {
    schedulesActions.confirmDelete(node.scheduleId);
  } else if (node.kind === 'sequence') {
    explorerActions.removeSequence(node.sequenceId);
  } else if (node.kind === 'mock') {
    explorerActions.removeMock(node.mockId);
  }
}

/**
 * Asks to delete `nodes`. One row goes through its kind's own confirm. Several go through one confirm that
 * counts them (**Delete 3 requests?**), or straight to deletion when Settings turned confirms off; a row
 * among them that has a confirm of its own (a project, an interface) still gets that one.
 */
export function deleteExplorerNodes(nodes: readonly ExplorerNode[]): void {
  if (nodes.length <= 1) {
    const [node] = nodes;
    if (node !== undefined) deleteOne(node);
    return;
  }
  const batch: PendingNodeDeletion[] = [];
  for (const node of nodes) {
    const pending = pendingDeletionOf(node);
    if (pending === undefined) deleteOne(node);
    else batch.push(pending);
  }
  if (batch.length === 0) return;
  if (!usePreferencesStore.getState().preferences.ui.confirmOnDelete) {
    for (const pending of batch) void runNodeDeletion(pending).catch(reportDeleteFailure);
    return;
  }
  useUiStore.getState().requestDeleteNodes(batch);
}

/**
 * Copies `nodes`, each beside its original. One row opens its copy, as its menu's **Duplicate** does;
 * several are copied without opening anything, so the tree is where the copies are found.
 */
export function duplicateExplorerNodes(nodes: readonly ExplorerNode[]): void {
  const targets = nodes.filter((node) => DUPLICABLE_KINDS.has(node.kind));
  if (targets.length === 1) {
    const [node] = targets;
    if (node === undefined) return;
    switch (node.kind) {
      case 'request':
        explorerActions.cloneRequest(node.requestId);
        return;
      case 'rest-request':
      case 'webhook-request':
        explorerActions.duplicateRestRequest(node.requestId);
        return;
      case 'grpc-request':
        explorerActions.duplicateGrpcRequest(node.requestId);
        return;
      case 'ws-request':
        explorerActions.duplicateWsRequest(node.requestId);
        return;
      case 'mcp-request':
        explorerActions.duplicateMcpRequest(node.requestId);
        return;
      case 'sequence':
        explorerActions.duplicateSequence(node.sequenceId);
        return;
      case 'mock':
        explorerActions.duplicateMock(node.mockId);
        return;
      default:
        return;
    }
  }
  const store = useProjectStore.getState();
  const report = (error: unknown): void => {
    showToast(error instanceof Error ? error.message : 'Duplicate failed');
  };
  for (const node of targets) {
    const copy = cloneOf(node, store);
    if (copy !== undefined) void copy.catch(report);
  }
}

function cloneOf(node: ExplorerNode, store: ReturnType<typeof useProjectStore.getState>): Promise<string> | undefined {
  switch (node.kind) {
    case 'request':
      return node.requestId === undefined ? undefined : store.cloneRequest(node.requestId);
    case 'rest-request':
    case 'webhook-request':
      return node.requestId === undefined ? undefined : store.cloneRestRequest(node.requestId);
    case 'grpc-request':
      return node.requestId === undefined ? undefined : store.cloneGrpcRequest(node.requestId);
    case 'ws-request':
      return node.requestId === undefined ? undefined : store.cloneWsRequest(node.requestId);
    case 'mcp-request':
      return node.requestId === undefined ? undefined : store.cloneMcpRequest(node.requestId);
    case 'sequence':
      return node.sequenceId === undefined ? undefined : store.duplicateSequence(node.sequenceId);
    case 'mock':
      return node.mockId === undefined ? undefined : store.duplicateMock(node.mockId);
    default:
      return undefined;
  }
}

/** The explorer row the active editor tab stands for, if the tab is one of the tree's rows. */
export function activeTabTreeNodeId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  const tab = tabs.find((candidate) => candidate.id === activeId);
  const contribution = tab === undefined ? undefined : TAB_KINDS[tab.kind];
  if (tab === undefined || contribution === undefined) return undefined;
  const id = entityIdOf(tab, contribution);
  return id === undefined ? undefined : contribution.treeNode?.(id, useProjectStore.getState());
}

/** Whether a tree command has something to act on: selected rows, or the active tab's row. Cheap: a `when` gate. */
export function hasExplorerTarget(): boolean {
  const tree = getExplorerTree();
  if (tree !== null && tree.selectedIds.size > 0) return true;
  return activeTabTreeNodeId() !== undefined;
}

/**
 * The rows a tree command acts on: the selection when there is one, else the active tab's row, unfolded to
 * so the tree holds it. Empty when neither is there.
 */
export function explorerTargets(): readonly NodeApi<ExplorerNode>[] {
  const tree = getExplorerTree();
  if (tree === null) return [];
  if (tree.selectedIds.size > 0) return tree.selectedNodes;
  const id = activeTabTreeNodeId();
  if (id === undefined) return [];
  tree.openParents(id);
  const node = tree.get(id);
  return node === null ? [] : [node];
}

/** The kind of the row a tree command would act on, for the gates that care which (Duplicate). */
export function explorerTargetKinds(): readonly ExplorerNode['kind'][] {
  const tree = getExplorerTree();
  if (tree !== null && tree.selectedIds.size > 0) return tree.selectedNodes.map((node) => node.data.kind);
  const id = activeTabTreeNodeId();
  const node = id === undefined || tree === null ? null : tree.get(id);
  if (node !== null) return [node.data.kind];
  // A folded-away row is not in the tree's visible list; its id's prefix still says what it is.
  const prefix = id?.split(':')[0];
  const kind = prefix === undefined ? undefined : KIND_BY_ID_PREFIX[prefix];
  return kind === undefined ? [] : [kind];
}

/** Tree id prefixes of the rows an editor tab can stand for, by kind (see `tree-nodes.ts`). */
const KIND_BY_ID_PREFIX: Readonly<Record<string, ExplorerNode['kind']>> = {
  req: 'request',
  rest: 'rest-request',
  grpc: 'grpc-request',
  ws: 'ws-request',
  mcp: 'mcp-request',
  api: 'api',
  'grpc-api': 'grpc-api',
  'ws-api': 'ws-api',
  'mcp-api': 'mcp-api',
  sequence: 'sequence',
  mock: 'mock',
  proj: 'project',
  iface: 'interface',
};

/**
 * The rows **Expand all** leaves folded (#685 E14): an operation's requests are one click away and named
 * after it, so unfolding every operation only doubles the rows; an interface's endpoints are read on its tab.
 */
const EXPAND_ALL_STOPS: ReadonlySet<ExplorerNode['kind']> = new Set<ExplorerNode['kind']>(['operation', 'endpoints']);

/** Unfolds every container down to the request level: projects, interfaces, APIs, bindings and folders. */
export function expandExplorerAll(): void {
  const tree = getExplorerTree();
  if (tree === null) return;
  tree.openAll();
  const stops: string[] = [];
  const visit = (node: NodeApi<ExplorerNode>): void => {
    if (node.isInternal && EXPAND_ALL_STOPS.has(node.data.kind)) stops.push(node.id);
    for (const child of node.children ?? []) visit(child);
  };
  for (const root of tree.root.children ?? []) visit(root);
  for (const id of stops) tree.close(id);
}

/** Starts an inline rename of the first target row, if its kind renames inline. */
export function renameExplorerTarget(): void {
  const [node] = explorerTargets();
  if (node === undefined || !node.isEditable) return;
  revealNode(node.id, { focus: true, rename: true });
}

/** Brings the Explorer into the sidebar, without folding it away when it is already in front. */
function showExplorer(): void {
  const ui = useUiStore.getState();
  if (ui.sidebar.visible && ui.sidebar.view === 'explorer') return;
  ui.showSidebarView('explorer');
}

/**
 * Shows the Explorer and puts keyboard focus in its tree: on the focused or selected row, else the first
 * row, else the tree's scroll container when the tree is empty.
 */
export function focusExplorer(): void {
  showExplorer();
  // The sidebar may be mounting the tree right now; focus lands once it has rendered.
  requestAnimationFrame(() => {
    const tree = getExplorerTree();
    const node = tree === null ? null : (tree.focusedNode ?? tree.selectedNodes[0] ?? tree.firstNode);
    if (tree !== null && node !== null && node !== undefined) {
      tree.focus(node, { scroll: true });
      const row = document.querySelector(`[data-tree-id="${CSS.escape(node.id)}"]`)?.closest('[role="treeitem"]');
      if (row instanceof HTMLElement) {
        row.focus({ preventScroll: true });
        return;
      }
    }
    const scroll = document.querySelector('[data-testid="explorer-tree-scroll"]');
    if (scroll instanceof HTMLElement) scroll.focus();
  });
}

/** Shows the Explorer and unfolds to, selects and focuses the active tab's row. */
export function revealActiveTab(): void {
  const id = activeTabTreeNodeId();
  if (id === undefined) return;
  showExplorer();
  revealNode(id, { focus: true });
}
