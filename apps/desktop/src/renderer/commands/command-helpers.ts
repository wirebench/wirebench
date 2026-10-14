import type { KindId } from '../../shared/kinds/kind-module.js';
import { explorerRole, kindExplorer } from '../kinds/index.js';
import { useEditorsStore } from '../state/editors.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';

/** The request draft behind the active editor tab, or `undefined` when none is a request tab. */
export function activeRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'request')?.requestId;
}

/** The REST request behind the active editor tab, or `undefined` when none is a REST tab. */
export function activeRestRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'rest-request')?.restRequestId;
}

/** The gRPC request behind the active editor tab, or `undefined` when none is a gRPC tab. */
export function activeGrpcRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'grpc-request')?.grpcRequestId;
}

/** The WebSocket request behind the active editor tab, or `undefined` when none is a WebSocket tab. */
export function activeWsRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'ws-request')?.wsRequestId;
}

/** The MCP request behind the active editor tab, or `undefined` when none is an MCP tab. */
export function activeMcpRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'mcp-request')?.mcpRequestId;
}

/** The sequence behind the active editor tab, or `undefined` when none is a sequence tab. */
export function activeSequenceId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'sequence')?.sequenceId;
}

/** The mock behind the active editor tab, or `undefined` when none is a mock tab. */
export function activeMockId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'mock')?.mockId;
}

/** The UI store's current actions. A function, not a binding: the store is replaced on every set. */
export function ui(): ReturnType<typeof useUiStore.getState> {
  return useUiStore.getState();
}

/** True when a request tab is active — the `when` gate every `request.*`/`editor.*` command shares. */
export function hasActiveRequest(): boolean {
  return activeRequestId() !== undefined;
}

/** Wraps a handler so it only runs with the active request's id, and is a no-op without one. */
export function onActiveRequest(run: (requestId: string) => void): () => void {
  return () => {
    const requestId = activeRequestId();
    if (requestId !== undefined) {
      run(requestId);
    }
  };
}

/** The part of the explorer selection the container commands read. */
type ContainerSelection = { readonly kind: string; readonly apiId?: string; readonly folderId?: string } | undefined;

/**
 * Whether the selected node sits in one of `kind`'s APIs: the API row, a request in it, or a folder
 * in it. The `<kind>.new*` commands are gated on their own container, so a gRPC folder never offers
 * a REST request.
 */
export function insideKindApi(kind: KindId, selection: ContainerSelection): boolean {
  const explorer = kindExplorer(kind);
  if (selection === undefined || explorer === undefined) return false;
  if (selection.kind === 'folder') {
    return selection.apiId !== undefined && explorer.ownsApi?.(selection.apiId, useProjectStore.getState()) === true;
  }
  return selection.kind in explorer.nodes;
}

/**
 * The folder a new node should land in: the selected folder itself, the folder holding the
 * selected request, or the API's root when an API row is selected.
 */
export function folderOf(selection: ContainerSelection): string | undefined {
  return selection !== undefined && explorerRole(selection.kind as never)?.dropTarget === true
    ? undefined
    : selection?.folderId;
}
