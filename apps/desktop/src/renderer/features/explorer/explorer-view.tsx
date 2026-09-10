import { useEffect, useRef, useState } from 'react';
import type { NodeApi, NodeRendererProps } from 'react-arborist';
import { Tree } from 'react-arborist';
import { FileDown, Folder, Network, Plug, RefreshCw, FoldVertical } from 'lucide-react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { IconButton } from '../../components/icon-button.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { ExplorerContextMenu } from './context-menu.js';
import { explorerActions } from './explorer-actions.js';
import { registerExplorerTree } from './explorer-api.js';
import type { ExplorerNode } from './tree-nodes.js';
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
  interface: Plug,
  endpoints: Folder,
  operations: Folder,
  binding: Network,
};

function NodeRow({ node, style, dragHandle }: NodeRendererProps<ExplorerNode>) {
  const Icon = NODE_ICON[node.data.kind];
  return (
    <ExplorerContextMenu node={node.data}>
      <div
        ref={dragHandle}
        style={style}
        data-testid="explorer-tree-row"
        data-tree-id={node.id}
        role="treeitem"
        aria-selected={node.isSelected}
        tabIndex={-1}
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
          <span className="min-w-0 flex-1 truncate">{node.data.label}</span>
        )}
        {node.data.problemCount !== undefined && node.data.problemCount > 0 && (
          <span className="shrink-0 rounded-full bg-danger px-1.5 text-xs text-fg-onAccent">
            {node.data.problemCount}
          </span>
        )}
      </div>
    </ExplorerContextMenu>
  );
}

/** The Explorer sidebar view: an empty state, or the interfaces/endpoints/operations/requests tree. */
export function ExplorerView() {
  const interfaces = useProjectStore((state) => state.interfaces);
  const order = useProjectStore((state) => state.order);
  const requests = useProjectStore((state) => state.requests);
  const removeInterface = useProjectStore((state) => state.removeInterface);
  const removeRequest = useProjectStore((state) => state.removeRequest);
  const setSelection = useUiStore((state) => state.setSelection);
  const openImportDialog = useUiStore((state) => state.openImportDialog);
  const confirmRemoveInterfaceId = useUiStore((state) => state.confirmRemoveInterfaceId);
  const confirmDeleteRequestId = useUiStore((state) => state.confirmDeleteRequestId);
  const requestRemoveInterface = useUiStore((state) => state.requestRemoveInterface);
  const requestDeleteRequest = useUiStore((state) => state.requestDeleteRequest);

  const [containerRef, size] = useElementSize<HTMLDivElement>();
  const [treeRef, setTreeRef] = useState<import('react-arborist').TreeApi<ExplorerNode> | null | undefined>(undefined);

  const summaries = order.map((id) => interfaces[id]).filter((s): s is NonNullable<typeof s> => s !== undefined);
  const data = buildExplorerTree(summaries, Object.values(requests));

  useEffect(() => {
    registerExplorerTree(treeRef ?? null);
    return () => registerExplorerTree(null);
  }, [treeRef]);

  const requestPendingDeletion = confirmDeleteRequestId !== undefined ? requests[confirmDeleteRequestId] : undefined;

  return (
    <div className="flex h-full min-h-0 flex-col">
      <div className="flex h-8 shrink-0 items-center justify-end gap-1 border-b border-hairline px-2">
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
          <div className="flex h-full flex-col items-center justify-center gap-1 px-4 text-center">
            <p className="text-md text-fg-muted">No interfaces yet</p>
            <p className="text-sm text-fg-subtle">Import a WSDL (⌘I) to get started.</p>
          </div>
        ) : (
          size.height > 0 && (
            <Tree<ExplorerNode>
              ref={setTreeRef}
              data={data}
              width={size.width}
              height={size.height}
              rowHeight={26}
              openByDefault
              disableEdit={(node) => node.kind !== 'request'}
              aria-label="Explorer"
              onActivate={(node: NodeApi<ExplorerNode>) => explorerActions.openRequest(node.data.requestId)}
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
                  id: node.id,
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
              }}
              onDelete={({ nodes }) => {
                for (const node of nodes) {
                  if (node.data.kind === 'interface') {
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

      <AlertDialog.Root
        open={confirmRemoveInterfaceId !== undefined}
        onOpenChange={(open) => !open && requestRemoveInterface(undefined)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
            <AlertDialog.Title className="text-md font-medium text-fg-default">Remove interface?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              This closes the imported definition and discards its request drafts.
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="rounded bg-danger px-3 py-1.5 text-sm text-fg-onAccent"
                  onClick={() => {
                    if (confirmRemoveInterfaceId !== undefined) {
                      void removeInterface(confirmRemoveInterfaceId);
                    }
                  }}
                >
                  Remove
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>

      <AlertDialog.Root
        open={confirmDeleteRequestId !== undefined}
        onOpenChange={(open) => !open && requestDeleteRequest(undefined)}
      >
        <AlertDialog.Portal>
          <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
          <AlertDialog.Content className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg">
            <AlertDialog.Title className="text-md font-medium text-fg-default">Delete request?</AlertDialog.Title>
            <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
              {requestPendingDeletion !== undefined
                ? `"${requestPendingDeletion.name}" will be deleted. This cannot be undone.`
                : 'This cannot be undone.'}
            </AlertDialog.Description>
            <div className="mt-4 flex justify-end gap-2">
              <AlertDialog.Cancel asChild>
                <button type="button" className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base">
                  Cancel
                </button>
              </AlertDialog.Cancel>
              <AlertDialog.Action asChild>
                <button
                  type="button"
                  className="rounded bg-danger px-3 py-1.5 text-sm text-fg-onAccent"
                  onClick={() => {
                    if (confirmDeleteRequestId !== undefined) {
                      removeRequest(confirmDeleteRequestId);
                    }
                  }}
                >
                  Delete
                </button>
              </AlertDialog.Action>
            </div>
          </AlertDialog.Content>
        </AlertDialog.Portal>
      </AlertDialog.Root>
    </div>
  );
}

function flatten(node: ExplorerNode): ExplorerNode[] {
  return [node, ...(node.children ?? []).flatMap(flatten)];
}
