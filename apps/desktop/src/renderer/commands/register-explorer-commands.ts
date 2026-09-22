import { catalogEntry } from '@shared/command-catalog.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';

/** Registers the `explorer.*` commands — the context menu's actions, reachable from the palette. */
export function registerExplorerCommands(): void {
  // Every explorer context-menu action is also a command, so the palette can run it against
  // whatever node is currently selected. The menu itself (context-menu.tsx) owns the actual
  // logic; these mirror the same `when` gates so the palette only lists what applies.
  registerCommand({
    ...catalogEntry('explorer.importAnother'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: () => {
      explorerActions.importAnother();
    },
  });
  registerCommand({
    ...catalogEntry('explorer.removeInterface'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.removeInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.showInterface'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.showInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.updateDefinition'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.updateDefinition(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.exportDefinition'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.exportDefinition(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.generateDocs'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.generateDocs(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.copyDefinitionUrl'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.copyDefinitionUrl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.newRequest'),
    when: (ctx) => ctx.selection?.kind === 'operation',
    whenScope: 'selection.operation',
    run: (ctx) => {
      explorerActions.newRequest(ctx.selection?.interfaceId, ctx.selection?.bindingName, ctx.selection?.operationName);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.copySoapAction'),
    when: (ctx) => ctx.selection?.kind === 'operation',
    whenScope: 'selection.operation',
    run: (ctx) => {
      explorerActions.copySoapAction(ctx.selection?.soapAction);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.openRequest'),
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.openRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.cloneRequest'),
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.cloneRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.renameRequest'),
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.renameRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.deleteRequest'),
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.deleteRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.recreateRequest'),
    when: (ctx) => ctx.selection?.kind === 'request',
    whenScope: 'selection.request',
    run: (ctx) => {
      explorerActions.recreateRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.checkWsiWsdl'),
    when: (ctx) => ctx.selection?.kind === 'interface',
    whenScope: 'selection.interface',
    run: (ctx) => {
      explorerActions.checkWsiWsdl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    ...catalogEntry('explorer.copyEndpointAddress'),
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
    ...catalogEntry('rest.newApi'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newApi(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('rest.newFolder'),
    when: (ctx) => insideApi(ctx.selection?.kind, ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newFolder(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  registerCommand({
    ...catalogEntry('rest.newRequest'),
    when: (ctx) => insideApi(ctx.selection?.kind, ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newRestRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  registerCommand({
    ...catalogEntry('rest.updateDefinition'),
    when: (ctx) => insideApi(ctx.selection?.kind, ctx.selection?.apiId) && hasRestDefinition(ctx.selection?.apiId),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.updateRestDefinition(ctx.selection?.apiId);
    },
  });

  // The gRPC creators, gated the same way on their own container.
  registerCommand({
    ...catalogEntry('grpc.newApi'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newGrpcApi(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('grpc.newRequest'),
    when: (ctx) => insideGrpcApi(ctx.selection),
    whenScope: 'selection.grpcApi',
    run: (ctx) => {
      explorerActions.newGrpcRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });

  // The WebSocket creators, gated the same way on their own container.
  registerCommand({
    ...catalogEntry('ws.newApi'),
    when: (ctx) => ctx.selection?.kind === 'project',
    whenScope: 'selection.project',
    run: (ctx) => {
      explorerActions.newWsApi(ctx.selection?.id);
    },
  });
  registerCommand({
    ...catalogEntry('ws.newRequest'),
    when: (ctx) => insideWsApi(ctx.selection),
    whenScope: 'selection.wsApi',
    run: (ctx) => {
      explorerActions.newWsRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
}

/**
 * Whether the selected node sits in a gRPC API. A folder row is one kind for every protocol, so a
 * selected folder counts when the API it names is a gRPC one.
 */
function insideGrpcApi(selection: { readonly kind: string; readonly apiId?: string } | undefined): boolean {
  if (selection === undefined) return false;
  if (selection.kind === 'grpc-api' || selection.kind === 'grpc-request') return true;
  return selection.kind === 'folder' && selection.apiId !== undefined && selection.apiId in grpcApis();
}

/**
 * Whether the selected node sits in a WebSocket API, for the same reason as {@link insideGrpcApi}.
 */
function insideWsApi(selection: { readonly kind: string; readonly apiId?: string } | undefined): boolean {
  if (selection === undefined) return false;
  if (selection.kind === 'ws-api' || selection.kind === 'ws-request') return true;
  return selection.kind === 'folder' && selection.apiId !== undefined && selection.apiId in wsApis();
}

/** Whether the selected node sits in a REST API, whichever of the three kinds it is. */
function insideApi(kind: string | undefined, apiId?: string): boolean {
  if (kind === 'folder') return apiId === undefined || (!(apiId in grpcApis()) && !(apiId in wsApis()));
  return kind === 'api' || kind === 'rest-request';
}

/** Whether the REST API records a definition, which is what Update Definition reads again. */
function hasRestDefinition(apiId: string | undefined): boolean {
  return apiId !== undefined && useProjectStore.getState().apis[apiId]?.definition !== undefined;
}

function grpcApis(): Readonly<Record<string, unknown>> {
  return useProjectStore.getState().grpcApis;
}

function wsApis(): Readonly<Record<string, unknown>> {
  return useProjectStore.getState().wsApis;
}

/**
 * The folder a new node should land in: the selected folder itself, the folder holding the
 * selected request, or the API's root when an API row is selected.
 */
function folderOf(selection: { readonly kind: string; readonly folderId?: string } | undefined): string | undefined {
  return selection?.kind === 'api' || selection?.kind === 'grpc-api' || selection?.kind === 'ws-api'
    ? undefined
    : selection?.folderId;
}
