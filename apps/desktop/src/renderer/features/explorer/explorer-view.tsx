import { useEffect, useRef, useState } from 'react';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { forwardRef } from 'react';
import { ListOuterElement, Tree } from 'react-arborist';
import {
  Box,
  FileDown,
  Folder,
  FolderPlus,
  Link2,
  Loader2,
  Network,
  Plug,
  RefreshCw,
  FoldVertical,
} from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { IconButton } from '../../components/icon-button.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { ExplorerContextMenu } from './context-menu.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { explorerActions } from './explorer-actions.js';
import { projectRowActions } from './project-actions.js';
import { registerExplorerTree } from './explorer-api.js';
import type { ExplorerNode, ExplorerProject } from './tree-nodes.js';
import { buildExplorerTree } from './tree-nodes.js';

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
};

const INLINE_BUTTON_CLASS =
  'shrink-0 rounded px-1.5 py-0.5 text-xs text-fg-default ring-1 ring-hairline-strong hover:bg-surface-base';

function NodeRow({ node, style, dragHandle }: NodeRendererProps<ExplorerNode>) {
  const Icon = NODE_ICON[node.data.kind];
  return (
    <ExplorerContextMenu node={node.data}>
      <div
        ref={dragHandle}
        style={style}
        data-testid={ROW_TESTID[node.data.kind] ?? 'explorer-tree-row'}
        data-tree-id={node.id}
        {...(node.data.projectId !== undefined ? { 'data-project-id': node.data.projectId } : {})}
        // No `role`/`aria-selected`/`tabIndex` here: react-arborist's own row wrapper is the
        // `treeitem` (with `aria-level`, `aria-selected` and `aria-expanded`), and repeating
        // them on this child would nest a second treeitem inside the real one.
        // A single click only selects (feeds the details panel / palette `when` gates); opening
        // a request tab needs a double-click or Enter. react-arborist's default row wrapper
        // calls `node.handleClick` (which both selects AND activates) on any click that bubbles
        // to it, so both handlers here stop propagation to keep that default from also firing.
        onClick={(e) => {
          e.stopPropagation();
          node.select();
        }}
        onDoubleClick={(e) => {
          e.stopPropagation();
          node.activate();
        }}
        className={`flex h-full items-center gap-1.5 px-1 text-sm ${
          node.isSelected ? 'bg-accent-muted text-fg-default' : 'text-fg-default hover:bg-surface-raised'
        }`}
      >
        {node.isInternal && (
          <span
            className="w-3 shrink-0 text-fg-subtle"
            onClick={(e) => {
              e.stopPropagation();
              node.toggle();
            }}
          >
            {node.isOpen ? '▾' : '▸'}
          </span>
        )}
        {Icon !== undefined && <Icon size={13} />}
        {node.isEditing ? (
          <input
            autoFocus
            defaultValue={node.data.label}
            className="min-w-0 flex-1 rounded bg-surface-base px-1 text-sm outline-none ring-1 ring-accent"
            onBlur={(e) => node.submit(e.currentTarget.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') node.submit(e.currentTarget.value);
              if (e.key === 'Escape') node.reset();
            }}
          />
        ) : (
          <span
            className={`min-w-0 flex-1 truncate ${node.data.kind === 'project-missing' ? 'text-status-danger' : ''}`}
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
  const removeInterface = useProjectStore((state) => state.removeInterface);
  const removeRequest = useProjectStore((state) => state.removeRequest);
  const setSelection = useUiStore((state) => state.setSelection);
  const projects = useProjectStore((state) => state.projects);
  const workspaceProjects = useWorkspaceStore((state) => state.workspace?.projects);
  const openImportDialog = useUiStore((state) => state.openImportDialog);
  const confirmRemoveInterfaceId = useUiStore((state) => state.confirmRemoveInterfaceId);
  const confirmDeleteRequestId = useUiStore((state) => state.confirmDeleteRequestId);
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
  const data = buildExplorerTree(roots, order, interfaces, Object.values(requests));

  useEffect(() => {
    registerExplorerTree(treeRef ?? null);
    return () => registerExplorerTree(null);
  }, [treeRef]);

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
        <IconButton label="Import WSDL…" onClick={openImportDialog}>
          <FileDown size={14} aria-hidden="true" />
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
            <p className="text-sm text-fg-subtle">Create a project, or import a WSDL into a new one.</p>
            <div className="mt-1 flex gap-2">
              <Button
                onClick={() => {
                  workspaceActions.newProject();
                }}
              >
                New project
              </Button>
              <Button variant="primary" onClick={openImportDialog}>
                Import WSDL…
              </Button>
            </div>
          </div>
        ) : (
          size.height > 0 && (
            <Tree<ExplorerNode>
              ref={setTreeRef}
              data={data}
              width={size.width}
              height={size.height}
              rowHeight={26}
              outerElementType={FocusableListOuter}
              openByDefault
              disableEdit={(node) => node.kind !== 'request' && node.kind !== 'project'}
              aria-label="Explorer"
              onActivate={(node: NodeApi<ExplorerNode>) => {
                // Double-click opens a request; on an interface row it opens the viewer, the
                // same thing "Show Interface Viewer" does.
                if (node.data.kind === 'project') {
                  // Double-clicking a root only folds it; a project has no editor of its own.
                  return;
                }
                if (node.data.kind === 'interface') {
                  explorerActions.showInterface(node.data.interfaceId);
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
                  ...(node.address !== undefined ? { address: node.address } : {}),
                });
              }}
              onRename={({ id, name }) => {
                const node = data.flatMap(flatten).find((n) => n.id === id);
                if (node?.kind === 'request' && node.requestId !== undefined) {
                  useProjectStore.getState().updateRequest(node.requestId, { name });
                }
                if (node?.kind === 'project' && node.projectId !== undefined) {
                  projectRowActions.commitRename(node.projectId, name);
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
