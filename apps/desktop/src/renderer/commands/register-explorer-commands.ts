import { explorerActions } from '../features/explorer/explorer-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';

/** Registers the `explorer.*` commands — the context menu's actions, reachable from the palette. */
export function registerExplorerCommands(): void {
  // Every explorer context-menu action is also a command, so the palette can run it against
  // whatever node is currently selected. The menu itself (context-menu.tsx) owns the actual
  // logic; these mirror the same `when` gates so the palette only lists what applies.
  registerCommand({
    id: 'explorer.importAnother',
    label: 'Explorer: Import Another WSDL…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: () => {
      explorerActions.importAnother();
    },
  });
  registerCommand({
    id: 'explorer.removeInterface',
    label: 'Explorer: Remove Interface',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.removeInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.showInterface',
    label: 'Explorer: Show Interface Viewer',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.showInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.updateDefinition',
    label: 'Explorer: Update Definition…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.updateDefinition(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.exportDefinition',
    label: 'Explorer: Export Definition…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.exportDefinition(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.generateDocs',
    label: 'Explorer: Generate Documentation…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.generateDocs(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.copyDefinitionUrl',
    label: 'Explorer: Copy Definition URL',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.copyDefinitionUrl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.newRequest',
    label: 'Explorer: New Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    whenScope: 'selection.operation',
    run: (ctx) => {
      explorerActions.newRequest(ctx.selection?.interfaceId, ctx.selection?.bindingName, ctx.selection?.operationName);
    },
  });
  registerCommand({
    id: 'explorer.copySoapAction',
    label: 'Explorer: Copy SOAPAction',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    whenScope: 'selection.operation',
    run: (ctx) => {
      explorerActions.copySoapAction(ctx.selection?.soapAction);
    },
  });
  registerCommand({
    id: 'explorer.openRequest',
    label: 'Explorer: Open Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.openRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.cloneRequest',
    label: 'Explorer: Clone Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.cloneRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.renameRequest',
    label: 'Explorer: Rename Request…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.renameRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.deleteRequest',
    label: 'Explorer: Delete Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.deleteRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.recreateRequest',
    label: 'Explorer: Recreate Request (keep values)',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.recreateRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.checkWsiWsdl',
    label: 'Explorer: Check WSDL WS-I compliance',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.checkWsiWsdl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.copyEndpointAddress',
    label: 'Explorer: Copy Endpoint Address',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'endpoint',
    whenScope: 'selection.endpoint',
    run: (ctx) => {
      explorerActions.copyEndpointAddress(ctx.selection?.address);
    },
  });

  // The three REST creators. Each is gated on a selection *anywhere inside* an API — a folder row
  // and a request row both name their API — so "New request" works from wherever the user is
  // rather than only on the API row itself.
  registerCommand({
    id: 'rest.newApi',
    label: 'REST: New API',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newApi(ctx.selection?.id);
    },
  });
  registerCommand({
    id: 'rest.newFolder',
    label: 'REST: New Folder',
    category: 'Explorer',
    when: (ctx) => insideApi(ctx.selection?.kind, ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newFolder(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  registerCommand({
    id: 'rest.newRequest',
    label: 'REST: New Request',
    category: 'Explorer',
    when: (ctx) => insideApi(ctx.selection?.kind, ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newRestRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });

  // The gRPC creators, gated the same way on their own container.
  registerCommand({
    id: 'grpc.newApi',
    label: 'gRPC: New API',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newGrpcApi(ctx.selection?.id);
    },
  });
  registerCommand({
    id: 'grpc.newRequest',
    label: 'gRPC: New Request',
    category: 'Explorer',
    when: (ctx) => insideGrpcApi(ctx.selection),
    whenScope: 'selection.grpcApi',
    run: (ctx) => {
      explorerActions.newGrpcRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
}

/**
 * Whether the selected node sits in a gRPC API. A folder row is one kind for both protocols, so a
 * selected folder counts when the API it names is a gRPC one.
 */
function insideGrpcApi(selection: { readonly kind: string; readonly apiId?: string } | undefined): boolean {
  if (selection === undefined) return false;
  if (selection.kind === 'grpc-api' || selection.kind === 'grpc-request') return true;
  return selection.kind === 'folder' && selection.apiId !== undefined && selection.apiId in grpcApis();
}

/** Whether the selected node sits in a REST API, whichever of the three kinds it is. */
function insideApi(kind: string | undefined, apiId?: string): boolean {
  if (kind === 'folder') return apiId === undefined || !(apiId in grpcApis());
  return kind === 'api' || kind === 'rest-request';
}

function grpcApis(): Readonly<Record<string, unknown>> {
  return useProjectStore.getState().grpcApis;
}

/**
 * The folder a new node should land in: the selected folder itself, the folder holding the
 * selected request, or the API's root when an API row is selected.
 */
function folderOf(selection: { readonly kind: string; readonly folderId?: string } | undefined): string | undefined {
  return selection?.kind === 'api' || selection?.kind === 'grpc-api' ? undefined : selection?.folderId;
}
