import { explorerActions } from '../features/explorer/explorer-actions.js';
import { registerCommand } from '../lib/commands.js';

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
    when: (ctx) => insideApi(ctx.selection?.kind),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newFolder(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
  registerCommand({
    id: 'rest.newRequest',
    label: 'REST: New Request',
    category: 'Explorer',
    when: (ctx) => insideApi(ctx.selection?.kind),
    whenScope: 'selection.api',
    run: (ctx) => {
      explorerActions.newRestRequest(ctx.selection?.apiId, folderOf(ctx.selection));
    },
  });
}

/** Whether the selected node sits in an API, whichever of the three kinds it is. */
function insideApi(kind: string | undefined): boolean {
  return kind === 'api' || kind === 'folder' || kind === 'rest-request';
}

/**
 * The folder a new node should land in: the selected folder itself, the folder holding the
 * selected request, or the API's root when an API row is selected.
 */
function folderOf(selection: { readonly kind: string; readonly folderId?: string } | undefined): string | undefined {
  return selection?.kind === 'api' ? undefined : selection?.folderId;
}
