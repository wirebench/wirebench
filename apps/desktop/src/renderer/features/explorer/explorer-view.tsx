import { useEffect, useRef, useState } from 'react';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { forwardRef } from 'react';
import { ListOuterElement, Tree } from 'react-arborist';
import {
  Box,
  ChevronDown,
  ChevronRight,
  FileDown,
  Folder,
  FolderPlus,
  FoldVertical,
  Globe,
  Link2,
  Loader2,
  Network,
  Plug,
  RefreshCw,
  UnfoldVertical,
} from 'lucide-react';
import { Button } from '../../components/button.js';
import { showToast } from '../../components/toast.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { useConflictTargets } from '../sync/use-conflict-targets.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { MethodBadge } from '../rest-api/method-badge.js';
import { ExplorerContextMenu } from './context-menu.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { explorerActions } from './explorer-actions.js';
import { openProjectTab, projectRowActions } from './project-actions.js';
import { isDropDisabled, planMoves } from './drag-drop.js';
import { getExplorerTree, registerExplorerTree } from './explorer-api.js';
import type { ExplorerNode, ExplorerProject } from './tree-nodes.js';
import { buildExplorerTree, nodeProjectId } from './tree-nodes.js';

/** Measures a container's box size with `ResizeObserver` so the virtualized tree can fill it. */
function useElementSize<T extends HTMLElement>(): [React.RefObject<T | null>, { width: number; height: number }] {
  const ref = useRef<T | null>(null);
  const [size, setSize] = useState({ width: 0, height: 0 });

  useEffect(() => {
    const el = ref.current;
    if (el === null) {
      return;
    }
    const observer = new ResizeObserver((entries) => {
      const entry = entries[0];
      if (entry !== undefined) {
        const { width, height } = entry.contentRect;
        setSize({ width, height });
      }
    });
    observer.observe(el);
    return () => {
      observer.disconnect();
    };
  }, []);

  return [ref, size];
}

const NODE_ICON: Partial<Record<ExplorerNode['kind'], React.ComponentType<{ size: number }>>> = {
  project: Box,
  interface: Plug,
  endpoints: Folder,
  operations: Folder,
  binding: Network,
  api: Globe,
  folder: Folder,
};

/**
 * react-arborist's scroll container, made focusable.
 *
 * The virtualised list is what actually scrolls, and a scrollable region nothing inside it can
 * focus is unreachable by keyboard alone (axe `scrollable-region-focusable`); the rows carry
 * `tabindex=-1`, so the container needs the tab stop. It is a `group` rather than
 * `presentation`: a presentational role is ignored on a focusable element, which would leave a
 * focusable generic sitting between the `tree` and its `treeitem`s, and `group` is a child the
 * `tree` role is allowed to own.
 */
const FocusableListOuter = forwardRef<HTMLDivElement, React.ComponentProps<typeof ListOuterElement>>(
  function FocusableListOuter(props, ref) {
    return <ListOuterElement ref={ref} {...props} data-testid="explorer-tree-scroll" role="group" tabIndex={0} />;
  },
);

/** Rows whose testid the names block fixes; everything else is a plain `explorer-tree-row`. */
const ROW_TESTID: Partial<Record<ExplorerNode['kind'], string>> = {
  project: 'explorer-project-row',
  'project-missing': 'explorer-project-missing',
  api: 'api-row',
  folder: 'folder-row',
  'rest-request': 'rest-request-row',
};

const INLINE_BUTTON_CLASS =
  'shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-default ring-1 ring-hairline-strong hover:bg-surface-base';

/**
 * The gap between the sidebar's edge and a row's chevron.
 *
 * It has to ride on the inline style rather than a `pl-*` class: react-arborist hands every row
 * `style.paddingLeft` (its per-level indent), and an inline padding beats any class we set — a
 * class here is silently dropped, and at the root level, where the indent is 0, it looks like no
 * padding was ever asked for.
 */
const ROW_PADDING_LEFT = 6;

function NodeRow({ node, style, dragHandle }: NodeRendererProps<ExplorerNode>) {
  const Icon = NODE_ICON[node.data.kind];
  const indent = typeof style.paddingLeft === 'number' ? style.paddingLeft : 0;
  const rowStyle = { ...style, paddingLeft: indent + ROW_PADDING_LEFT };
  return (
    <ExplorerContextMenu node={node.data}>
      <div
        ref={dragHandle}
        style={rowStyle}
        data-testid={ROW_TESTID[node.data.kind] ?? 'explorer-tree-row'}
        data-tree-id={node.id}
        {...(node.data.projectId !== undefined ? { 'data-project-id': node.data.projectId } : {})}
        // No `role`/`aria-selected`/`tabIndex` here: react-arborist's own row wrapper is the
        // `treeitem` (with `aria-level`, `aria-selected` and `aria-expanded`), and repeating
        // them on this child would nest a second treeitem inside the real one.
        // One click does the obvious thing for the row it lands on: a request opens, and
        // anything with children folds or unfolds. Everything else selects only — that is what
        // feeds the details panel and the palette's `when` gates. react-arborist's default row
        // wrapper calls `node.handleClick` (which both selects AND activates) on any click that
        // bubbles to it, so both handlers here stop propagation to keep it from also firing.
        onClick={(e) => {
          e.stopPropagation();
          node.select();
          if (node.data.kind === 'request' || node.data.kind === 'rest-request') {
            node.activate();
          } else if (node.data.kind === 'api') {
            // An API opens its tab AND folds, unlike an interface: the tab is where its base URL
            // and credentials live, and the row is also the container the user is about to expand.
            node.activate();
            node.toggle();
          } else if (node.isInternal) {
            // A project row opens its tab from `onSelect` (see below) and folds under the same
            // click, like an API row: the row is both the thing the tab is about and the container
            // the user is reaching into.
            node.toggle();
          }
        }}
        // Kept for the rows a single click does not open: the interface viewer still answers to
        // a double-click, as it always has, so folding an interface open costs nothing.
        onDoubleClick={(e) => {
          e.stopPropagation();
          node.activate();
        }}
        className={`flex h-full items-center pr-1 text-sm ${
          node.isSelected ? 'bg-accent-muted text-fg-default' : 'text-fg-default hover:bg-surface-raised'
        }`}
      >
        {/* The chevron's width is reserved on leaves as well, so a request's name lines up with the
            folder names around it: the fold marker is what differs between those rows, not the
            column their names start in. */}
        <span
          className="flex w-2.5 shrink-0 items-center text-fg-subtle"
          data-testid="explorer-row-twisty"
          onClick={(e) => {
            if (!node.isInternal) return;
            e.stopPropagation();
            node.toggle();
          }}
        >
          {node.isInternal &&
            (node.isOpen ? (
              <ChevronDown size={11} aria-hidden="true" />
            ) : (
              <ChevronRight size={11} aria-hidden="true" />
            ))}
        </span>
        {/* One gutter of fixed width carries whatever marks the row — a kind icon or the method —
            hard against the name. Right-aligning it lines the method labels up with each other and
            every name in the tree with every other, however wide GET, DELETE or PROPFIND is. */}
        <span className="flex w-6 shrink-0 items-center justify-end overflow-hidden" data-testid="explorer-row-gutter">
          {node.data.kind === 'rest-request' && node.data.method !== undefined ? (
            <MethodBadge
              method={node.data.method}
              title={`${node.data.method} ${node.data.label}`}
              compact
              className="w-auto"
            />
          ) : (
            Icon !== undefined && <Icon size={13} />
          )}
        </span>
        {node.isEditing ? (
          <input
            autoFocus
            defaultValue={node.data.label}
            className="ml-1 min-w-0 flex-1 rounded bg-surface-base px-1 text-sm outline-none ring-1 ring-accent"
            onClick={(e) => e.stopPropagation()}
            onMouseDown={(e) => e.stopPropagation()}
            onFocus={(e) => e.currentTarget.select()}
            onBlur={(e) => node.submit(e.currentTarget.value)}
            onKeyDown={(e) => {
              // Keep typing inside the rename field away from the tree's own keys, but let chords
              // (⌘⏎ send, ⌘S save…) reach the window-level keybindings.
              if (!e.metaKey && !e.ctrlKey && !e.altKey) e.stopPropagation();
              if (e.key === 'Enter') node.submit(e.currentTarget.value);
              if (e.key === 'Escape') node.reset();
            }}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate pl-1 ${node.data.kind === 'project-missing' ? 'text-status-danger' : ''}`}
          >
            {node.data.label}
          </span>
        )}
        {node.data.kind === 'project-missing' && node.data.projectId !== undefined && (
          <span className="flex shrink-0 items-center gap-1">
            <button
              type="button"
              className={INLINE_BUTTON_CLASS}
              onClick={(e) => {
                e.stopPropagation();
                projectRowActions.locate(node.data.projectId ?? '');
              }}
            >
              Locate…
            </button>
            <button
              type="button"
              className={INLINE_BUTTON_CLASS}
              onClick={(e) => {
                e.stopPropagation();
                projectRowActions.remove(node.data.projectId ?? '');
              }}
            >
              Remove
            </button>
          </span>
        )}
        {node.data.kind === 'api' && (
          <span
            data-testid="explorer-api-badge"
            className="shrink-0 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
          >
            REST
          </span>
        )}
        {node.data.kind === 'project' && node.data.linked === true && (
          <span
            data-testid="explorer-project-linked-badge"
            title={node.data.dir}
            className="flex shrink-0 items-center gap-0.5 rounded-full bg-surface-base px-1.5 text-xs text-fg-subtle"
          >
            <Link2 size={11} aria-hidden="true" />
            linked
          </span>
        )}
        {node.data.kind === 'project' && node.data.loading === true && (
          <span className="flex shrink-0 items-center gap-1 text-xs text-fg-subtle">
            <Loader2 size={11} aria-hidden="true" className="animate-spin" />
            opening…
          </span>
        )}
        {node.data.orphaned === true && (
          <span
            data-testid="explorer-orphaned-badge"
            title="This operation is no longer in the definition"
            className="shrink-0 rounded-full bg-status-warning px-1.5 text-xs text-fg-on-accent"
          >
            orphaned
          </span>
        )}
        {node.data.conflicted === true && (
          <span
            data-testid="explorer-conflict-badge"
            title="Has unresolved sync conflicts"
            className="shrink-0 rounded-full bg-status-danger px-1.5 text-xs text-fg-on-accent"
          >
            conflict
          </span>
        )}
        {node.data.problemCount !== undefined && node.data.problemCount > 0 && (
          <span className="shrink-0 rounded-full bg-status-danger px-1.5 text-xs text-fg-on-accent">
            {node.data.problemCount}
          </span>
        )}
      </div>
    </ExplorerContextMenu>
  );
}

/**
 * The Explorer sidebar view: an empty state offering both ways into a first project, or one
 * root per project in the open workspace with its interfaces/endpoints/operations/requests
 * beneath it.
 */
export function ExplorerView() {
  const interfaces = useProjectStore((state) => state.interfaces);
  const order = useProjectStore((state) => state.order);
  const requests = useProjectStore((state) => state.requests);
  const rest = useProjectStore((state) => state.rest);
  const removeInterface = useProjectStore((state) => state.removeInterface);
  const removeRequest = useProjectStore((state) => state.removeRequest);
  const setSelection = useUiStore((state) => state.setSelection);
  const projects = useProjectStore((state) => state.projects);
  const workspaceProjects = useWorkspaceStore((state) => state.workspace?.projects);
  const workspaceId = useWorkspaceStore((state) => state.workspace?.id);
  const shared = useWorkspaceStore((state) => state.workspace?.share !== undefined);
  const setExplorerOpen = useUiStore((state) => state.setExplorerOpen);
  const openImportDialog = useUiStore((state) => state.openImportDialog);
  const confirmRemoveInterfaceId = useUiStore((state) => state.confirmRemoveInterfaceId);
  const confirmDeleteRequestId = useUiStore((state) => state.confirmDeleteRequestId);
  const confirmDeleteNode = useUiStore((state) => state.confirmDeleteNode);
  const requestDeleteNode = useUiStore((state) => state.requestDeleteNode);
  const requestRemoveInterface = useUiStore((state) => state.requestRemoveInterface);
  const requestDeleteRequest = useUiStore((state) => state.requestDeleteRequest);

  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const [treeRef, setTreeRef] = useState<import('react-arborist').TreeApi<ExplorerNode> | null | undefined>(undefined);

  // One root per project in the open workspace, in the manifest's order. The *name* comes from
  // the project mirror when it holds one: a rename reaches it (`project.changed`) before the
  // workspace snapshot catches up, and the row must not lag a rename the user just typed.
  const roots: readonly ExplorerProject[] = (workspaceProjects ?? []).map((project) => ({
    id: project.id,
    name: projects[project.id]?.name ?? project.name,
    source: project.source,
    dir: project.dir,
    status: project.status,
    ...(project.message !== undefined ? { message: project.message } : {}),
  }));
  const conflicted = useConflictTargets();
  const data = buildExplorerTree(roots, order, interfaces, Object.values(requests), rest, conflicted);

  useEffect(() => {
    registerExplorerTree(treeRef ?? null);
    return () => registerExplorerTree(null);
  }, [treeRef]);

  // What the user last folded open or shut in this workspace. Read once per tree mount — the tree
  // owns the live state and reports every change back through `onToggle`.
  const storedOpen = (): Readonly<Record<string, boolean>> =>
    (workspaceId === undefined ? undefined : useUiStore.getState().workspaces[workspaceId]?.explorerOpen) ?? {};

  // Everything below a project starts folded shut (so a freshly imported interface arrives
  // collapsed), but a project root starts open unless the user shut it. A root that appears after
  // the tree mounted — a new project, an import into a new one — is not in the tree's initial
  // state, so it is unfolded here.
  const rootIds = data.map((root) => root.id).join('\n');
  useEffect(() => {
    if (treeRef === null || treeRef === undefined) {
      return;
    }
    const stored = storedOpen();
    for (const id of rootIds.split('\n')) {
      if (id !== '' && stored[id] === undefined && !treeRef.isOpen(id)) {
        treeRef.open(id);
      }
    }
    // `storedOpen` reads the store directly; it is deliberately not a dependency.
  }, [treeRef, rootIds]);

  const requestPendingDeletion = confirmDeleteRequestId !== undefined ? requests[confirmDeleteRequestId] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-hairline px-2">
        <IconButton
          data-testid="explorer-new-project"
          label="New Project…"
          onClick={() => {
            workspaceActions.newProject();
          }}
        >
          <FolderPlus size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Import…" onClick={() => openImportDialog()}>
          <FileDown size={14} aria-hidden="true" />
        </IconButton>
        <IconButton
          data-testid="explorer-link-project"
          label={
            shared
              ? 'Shared workspaces hold their projects inside the workspace; use Move to workspace…'
              : 'Link Project Folder…'
          }
          disabled={shared}
          onClick={() => {
            void workspaceActions.linkProject();
          }}
        >
          <Link2 size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Expand all" onClick={() => treeRef?.openAll()}>
          <UnfoldVertical size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Collapse all" onClick={() => treeRef?.closeAll()}>
          <FoldVertical size={14} aria-hidden="true" />
        </IconButton>
        <IconButton label="Refresh" disabled onClick={() => {}}>
          <RefreshCw size={14} aria-hidden="true" />
        </IconButton>
      </div>

      <div ref={containerRef} className="min-h-0 flex-1">
        {data.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 px-4 text-center">
            <p className="text-md text-fg-muted">No projects yet</p>
            <p className="text-sm text-fg-subtle">
              Create a project, or import an API or service definition into a new one.
            </p>
            <div className="mt-1 flex gap-2">
              <Button
                onClick={() => {
                  workspaceActions.newProject();
                }}
              >
                New project
              </Button>
              <Button variant="primary" onClick={() => openImportDialog()}>
                Import…
              </Button>
            </div>
          </div>
        ) : (
          size.height > 0 && (
            <Tree<ExplorerNode>
              // Remounted per workspace, so each one starts from its own remembered fold state.
              key={workspaceId}
              ref={setTreeRef}
              data={data}
              width={size.width}
              height={size.height}
              rowHeight={26}
              // Half react-arborist's 24px default: enough that a subfolder reads as sitting inside
              // its folder at a glance, without the four levels of this tree — project › API ›
              // folder › request — marching a request off to the right.
              indent={12}
              outerElementType={FocusableListOuter}
              openByDefault={false}
              initialOpenState={{ ...Object.fromEntries(data.map((root) => [root.id, true])), ...storedOpen() }}
              onToggle={(id) => {
                const tree = getExplorerTree();
                if (workspaceId !== undefined && tree !== null) {
                  setExplorerOpen(workspaceId, id, tree.isOpen(id));
                }
              }}
              disableEdit={(node) =>
                node.kind !== 'request' &&
                node.kind !== 'project' &&
                node.kind !== 'api' &&
                node.kind !== 'folder' &&
                node.kind !== 'rest-request'
              }
              disableDrag={(node) => node.kind !== 'rest-request' && node.kind !== 'folder'}
              // Reordering and moving happen inside the same API: a request or folder belongs to its
              // own API definition, and cannot move into another API or project.
              disableDrop={({ parentNode, dragNodes, index }) => {
                const ancestors: ExplorerNode[] = [];
                for (let node = parentNode?.parent ?? null; node !== null; node = node.parent) {
                  if (node.data !== undefined) ancestors.push(node.data);
                }
                return isDropDisabled({
                  parent: parentNode?.data,
                  children: (parentNode?.children ?? []).map((child) => child.data),
                  dragged: dragNodes[0]?.data,
                  index,
                  sameProject: sameProject(parentNode?.data, dragNodes[0]?.data),
                  ancestors,
                });
              }}
              onMove={async ({ dragNodes, parentNode, index }) => {
                const parent = parentNode?.data;
                if (parent === undefined || (parent.kind !== 'api' && parent.kind !== 'folder')) return;
                const targetFolderId = parent.kind === 'folder' ? parent.folderId : undefined;
                const plan = planMoves(
                  (parentNode?.children ?? []).map((child) => child.data),
                  dragNodes.map((node) => node.data),
                  index,
                );
                // One at a time and in order: each move's index assumes the previous one landed.
                for (const move of plan) {
                  try {
                    await useProjectStore.getState().moveNode(move.entityId, targetFolderId, move.index);
                  } catch (error: unknown) {
                    showToast(error instanceof Error ? error.message : 'Could not move it');
                  }
                }
              }}
              aria-label="Explorer"
              onActivate={(node: NodeApi<ExplorerNode>) => {
                // Reached by a click on a request row, a double-click on anything, and Enter.
                // On an interface row it opens the viewer, the same thing "Show Interface
                // Viewer" does.
                if (node.data.kind === 'project') {
                  // A project has no editor of its own; its tab opens from `onSelect`.
                  return;
                }
                if (node.data.kind === 'interface') {
                  explorerActions.showInterface(node.data.interfaceId);
                  return;
                }
                if (node.data.kind === 'api') {
                  explorerActions.openApi(node.data.apiId);
                  return;
                }
                if (node.data.kind === 'rest-request') {
                  explorerActions.openRestRequest(node.data.requestId);
                  return;
                }
                explorerActions.openRequest(node.data.requestId);
              }}
              onSelect={(nodes) => {
                const node = nodes[0]?.data;
                if (node === undefined) {
                  setSelection(undefined);
                  return;
                }
                const definitionUrl =
                  node.kind === 'interface' ? interfaces[node.interfaceId ?? '']?.definitionUrl : undefined;
                // A project row's tab opens immediately on selection — a single click, not a
                // double-click — per the approved spec's amendment; project rows have no
                // "activate" behaviour of their own (see `onActivate` below), so this is the
                // only path that opens one.
                if (node.kind === 'project' && node.projectId !== undefined) {
                  openProjectTab(node.projectId);
                }
                setSelection({
                  kind: node.kind,
                  // A project row stands for a project, so the selection names the project id —
                  // what `selection.project` commands and the details panel both read.
                  id: node.kind === 'project' ? (node.projectId ?? node.id) : node.id,
                  ...(node.interfaceId !== undefined ? { interfaceId: node.interfaceId } : {}),
                  ...(definitionUrl !== undefined ? { definitionUrl } : {}),
                  ...(node.bindingName !== undefined ? { bindingName: node.bindingName } : {}),
                  ...(node.operationName !== undefined ? { operationName: node.operationName } : {}),
                  ...(node.soapAction !== undefined ? { soapAction: node.soapAction } : {}),
                  ...(node.requestId !== undefined ? { requestId: node.requestId } : {}),
                  ...(node.apiId !== undefined ? { apiId: node.apiId } : {}),
                  ...(node.folderId !== undefined ? { folderId: node.folderId } : {}),
                  ...(node.address !== undefined ? { address: node.address } : {}),
                });
              }}
              onRename={({ id, name }) => {
                const node = data.flatMap(flatten).find((n) => n.id === id);
                if (node === undefined) return;
                const trimmed = name.trim();
                if (trimmed.length === 0 || trimmed === node.label) {
                  return;
                }
                if (node.kind === 'request' && node.requestId !== undefined) {
                  useProjectStore.getState().updateRequest(node.requestId, { name: trimmed });
                }
                if (node.kind === 'project' && node.projectId !== undefined) {
                  projectRowActions.commitRename(node.projectId, trimmed);
                }
                if (node.kind === 'api' && node.apiId !== undefined) {
                  void useProjectStore.getState().updateApi(node.apiId, { name: trimmed }).catch(reportRenameFailure);
                }
                if (node.kind === 'folder' && node.folderId !== undefined) {
                  void useProjectStore
                    .getState()
                    .updateFolder(node.folderId, { name: trimmed })
                    .catch(reportRenameFailure);
                }
                if (node.kind === 'rest-request' && node.requestId !== undefined) {
                  void useProjectStore
                    .getState()
                    .updateRestRequest(node.requestId, { name: trimmed })
                    .catch(reportRenameFailure);
                }
              }}
              onDelete={({ nodes }) => {
                for (const node of nodes) {
                  if (node.data.kind === 'project' && node.data.projectId !== undefined) {
                    projectRowActions.remove(node.data.projectId);
                  } else if (node.data.kind === 'interface') {
                    requestRemoveInterface(node.data.interfaceId);
                  } else if (node.data.kind === 'request') {
                    requestDeleteRequest(node.data.requestId);
                  } else if (node.data.kind === 'api') {
                    explorerActions.removeApi(node.data.apiId);
                  } else if (node.data.kind === 'folder') {
                    explorerActions.removeFolder(node.data.folderId);
                  } else if (node.data.kind === 'rest-request') {
                    explorerActions.deleteRestRequest(node.data.requestId);
                  }
                }
              }}
            >
              {(props) => <NodeRow {...props} />}
            </Tree>
          )
        )}
      </div>

      <ConfirmDialog
        open={confirmRemoveInterfaceId !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestRemoveInterface(undefined);
          }
        }}
        title="Remove interface?"
        description="This closes the imported definition and discards its request drafts."
        confirmLabel="Remove"
        destructive
        onConfirm={() => {
          if (confirmRemoveInterfaceId !== undefined) {
            void removeInterface(confirmRemoveInterfaceId);
          }
        }}
      />

      <ConfirmDialog
        open={confirmDeleteNode !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestDeleteNode(undefined);
          }
        }}
        title={
          confirmDeleteNode?.kind === 'api'
            ? 'Delete API?'
            : confirmDeleteNode?.kind === 'folder'
              ? 'Delete folder?'
              : 'Delete request?'
        }
        description={
          confirmDeleteNode === undefined
            ? 'This cannot be undone.'
            : `"${confirmDeleteNode.name}"${
                confirmDeleteNode.requestCount > 0
                  ? ` and the ${String(confirmDeleteNode.requestCount)} request(s) inside it`
                  : ''
              } will be deleted. This cannot be undone.`
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmDeleteNode === undefined) {
            return;
          }
          const store = useProjectStore.getState();
          const { kind, id } = confirmDeleteNode;
          const done =
            kind === 'api'
              ? store.removeApi(id)
              : kind === 'folder'
                ? store.removeFolder(id)
                : store.removeRestRequest(id);
          void done.catch((error: unknown) => {
            showToast(error instanceof Error ? error.message : 'Delete failed');
          });
        }}
      />

      <ConfirmDialog
        open={confirmDeleteRequestId !== undefined}
        onOpenChange={(open) => {
          if (!open) {
            requestDeleteRequest(undefined);
          }
        }}
        title="Delete request?"
        description={
          requestPendingDeletion !== undefined
            ? `"${requestPendingDeletion.name}" will be deleted. This cannot be undone.`
            : 'This cannot be undone.'
        }
        confirmLabel="Delete"
        destructive
        onConfirm={() => {
          if (confirmDeleteRequestId !== undefined) {
            void removeRequest(confirmDeleteRequestId);
          }
        }}
      />
    </div>
  );
}

function flatten(node: ExplorerNode): ExplorerNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}

/** Whether a drop target and the node being dragged live in the same project. */
export function sameProject(target: ExplorerNode | undefined, dragged: ExplorerNode | undefined): boolean {
  const projectOf = useProjectStore.getState().projectOf;
  const into = nodeProjectId(target, projectOf);
  const from = nodeProjectId(dragged, projectOf);
  return into !== undefined && into === from;
}

function reportRenameFailure(error: unknown): void {
  showToast(error instanceof Error ? error.message : 'Could not rename it');
}
