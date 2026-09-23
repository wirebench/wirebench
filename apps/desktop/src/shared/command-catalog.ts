import type { CommandCategory, CommandId } from './commands.js';

/**
 * The declarative half of a command's catalog entry: everything a consumer needs to describe
 * it — in a palette, a menu, or a generated docs page — without knowing how it runs or when
 * it is available. See {@link COMMAND_CATALOG}.
 */
export interface CommandCatalogEntry {
  readonly id: CommandId;
  readonly label: string;
  readonly category: CommandCategory;
  readonly shortcut?: string;
  readonly extraShortcuts?: readonly string[];
}

/**
 * Every command's static metadata — id, label, category, shortcut and extraShortcuts — keyed
 * by {@link CommandId}. This is the single source of truth for that data; the `register-*`
 * modules under `renderer/commands` read it back by id and add only `run`, `when` and
 * `whenScope`, which need the renderer's stores and so cannot live here.
 *
 * Kept free of DOM and renderer imports so a Node script (the docs command reference) can
 * import it directly, without pulling in Electron, React or Monaco.
 */
export const COMMAND_CATALOG: Readonly<Record<CommandId, CommandCatalogEntry>> = {
  'app.checkForUpdates': {
    id: 'app.checkForUpdates',
    label: 'Check for Updates…',
    category: 'General',
  },
  'palette.open': {
    id: 'palette.open',
    label: 'Show All Commands',
    category: 'General',
    shortcut: 'Mod+K',
    // The design gives the palette both ⌘K and ⌘⇧P; the second is an alias, so it is not
    // offered to the menu and cannot be rebound on its own.
    extraShortcuts: ['Mod+Shift+P'],
  },
  'palette.quickOpen': {
    id: 'palette.quickOpen',
    label: 'Go to Operation or Request…',
    category: 'General',
    shortcut: 'Mod+P',
  },
  'view.toggleSidebar': {
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    category: 'View',
    shortcut: 'Mod+B',
  },
  'view.toggleConsole': {
    id: 'view.toggleConsole',
    label: 'Toggle Console',
    category: 'View',
    shortcut: 'Mod+J',
  },
  'view.toggleCode': {
    id: 'view.toggleCode',
    label: 'Toggle Code Panel',
    category: 'View',
    shortcut: 'Mod+Alt+B',
  },
  'view.showExplorer': {
    id: 'view.showExplorer',
    label: 'Show Explorer',
    category: 'View',
    shortcut: 'Mod+Shift+E',
  },
  'view.showEnvironments': {
    id: 'view.showEnvironments',
    label: 'Show Environments',
    category: 'View',
  },
  'view.showSearch': {
    id: 'view.showSearch',
    label: 'Show Search',
    category: 'View',
    shortcut: 'Mod+Shift+S',
  },
  'view.showHistory': {
    id: 'view.showHistory',
    label: 'Show History',
    category: 'View',
    shortcut: 'Mod+Shift+Y',
  },
  'view.showWss': {
    id: 'view.showWss',
    label: 'Show WS-Security',
    category: 'View',
  },
  'view.showSettings': {
    id: 'view.showSettings',
    label: 'Show Settings',
    category: 'View',
    shortcut: 'Mod+Comma',
  },
  'view.toggleTheme': {
    id: 'view.toggleTheme',
    label: 'Cycle Theme (Dark, Light, System)',
    category: 'View',
  },
  'preferences.open': {
    id: 'preferences.open',
    label: 'Open Preferences',
    category: 'General',
  },
  'definition.import': {
    id: 'definition.import',
    label: 'Import…',
    category: 'Definition',
    shortcut: 'Mod+I',
  },
  'definition.importLegacyProject': {
    id: 'definition.importLegacyProject',
    label: 'Import Legacy SOAP Project…',
    category: 'Definition',
  },
  'item.save': {
    id: 'item.save',
    label: 'Save',
    category: 'Project',
    shortcut: 'Mod+S',
  },
  'project.save': {
    id: 'project.save',
    label: 'Save All',
    category: 'Project',
    shortcut: 'Mod+Alt+S',
  },
  'workspace.create': {
    id: 'workspace.create',
    label: 'Create Workspace…',
    category: 'Workspace',
  },
  'workspace.switch': {
    id: 'workspace.switch',
    label: 'Switch Workspace…',
    category: 'Workspace',
  },
  'workspace.manage': {
    id: 'workspace.manage',
    label: 'Manage Workspaces…',
    category: 'Workspace',
  },
  'workspace.newProject': {
    id: 'workspace.newProject',
    label: 'New Project…',
    category: 'Workspace',
    shortcut: 'Mod+Shift+N',
  },
  'workspace.linkProject': {
    id: 'workspace.linkProject',
    label: 'Link Project Folder…',
    category: 'Workspace',
  },
  'workspace.importProjectFolder': {
    id: 'workspace.importProjectFolder',
    label: 'Import Project Folder…',
    category: 'Workspace',
  },
  'workspace.exportProject': {
    id: 'workspace.exportProject',
    label: 'Export Project…',
    category: 'Workspace',
  },
  'workspace.removeProject': {
    id: 'workspace.removeProject',
    label: 'Remove Project from Workspace…',
    category: 'Workspace',
  },
  'explorer.importAnother': {
    id: 'explorer.importAnother',
    label: 'Explorer: Import Another WSDL…',
    category: 'Explorer',
  },
  'explorer.removeInterface': {
    id: 'explorer.removeInterface',
    label: 'Explorer: Remove Interface',
    category: 'Explorer',
  },
  'explorer.showInterface': {
    id: 'explorer.showInterface',
    label: 'Explorer: Show Interface Viewer',
    category: 'Explorer',
  },
  'explorer.updateDefinition': {
    id: 'explorer.updateDefinition',
    label: 'Explorer: Update Definition…',
    category: 'Explorer',
  },
  'explorer.exportDefinition': {
    id: 'explorer.exportDefinition',
    label: 'Explorer: Export Definition…',
    category: 'Explorer',
  },
  'explorer.generateDocs': {
    id: 'explorer.generateDocs',
    label: 'Explorer: Generate Documentation…',
    category: 'Explorer',
  },
  'explorer.copyDefinitionUrl': {
    id: 'explorer.copyDefinitionUrl',
    label: 'Explorer: Copy Definition URL',
    category: 'Explorer',
  },
  'explorer.newRequest': {
    id: 'explorer.newRequest',
    label: 'Explorer: New Request',
    category: 'Explorer',
  },
  'explorer.copySoapAction': {
    id: 'explorer.copySoapAction',
    label: 'Explorer: Copy SOAPAction',
    category: 'Explorer',
  },
  'explorer.openRequest': {
    id: 'explorer.openRequest',
    label: 'Explorer: Open Request',
    category: 'Explorer',
  },
  'explorer.cloneRequest': {
    id: 'explorer.cloneRequest',
    label: 'Explorer: Clone Request',
    category: 'Explorer',
  },
  'explorer.renameRequest': {
    id: 'explorer.renameRequest',
    label: 'Explorer: Rename Request…',
    category: 'Explorer',
  },
  'explorer.deleteRequest': {
    id: 'explorer.deleteRequest',
    label: 'Explorer: Delete Request',
    category: 'Explorer',
  },
  'explorer.recreateRequest': {
    id: 'explorer.recreateRequest',
    label: 'Explorer: Recreate Request (keep values)',
    category: 'Explorer',
  },
  'explorer.copyEndpointAddress': {
    id: 'explorer.copyEndpointAddress',
    label: 'Explorer: Copy Endpoint Address',
    category: 'Explorer',
  },
  'explorer.checkWsiWsdl': {
    id: 'explorer.checkWsiWsdl',
    label: 'Explorer: Check WSDL WS-I compliance',
    category: 'Explorer',
  },
  'rest.send': {
    id: 'rest.send',
    label: 'Send REST Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'rest.copyAsCurl': {
    id: 'rest.copyAsCurl',
    label: 'REST: Copy as cURL',
    category: 'Request',
  },
  'rest.importCurl': {
    id: 'rest.importCurl',
    label: 'REST: Import cURL…',
    category: 'Request',
  },
  'rest.getToken': {
    id: 'rest.getToken',
    label: 'REST: Get OAuth2 Token',
    category: 'Request',
  },
  'rest.importOpenApi': {
    id: 'rest.importOpenApi',
    label: 'REST: Import OpenAPI…',
    category: 'Definition',
    shortcut: 'Mod+Shift+I',
  },
  'rest.importPostman': {
    id: 'rest.importPostman',
    label: 'REST: Import Postman Collection…',
    category: 'Definition',
  },
  'rest.newApi': {
    id: 'rest.newApi',
    label: 'REST: New API',
    category: 'Explorer',
  },
  'rest.newFolder': {
    id: 'rest.newFolder',
    label: 'REST: New Folder',
    category: 'Explorer',
  },
  'rest.newRequest': {
    id: 'rest.newRequest',
    label: 'REST: New Request',
    category: 'Explorer',
  },
  'rest.updateDefinition': {
    id: 'rest.updateDefinition',
    label: 'REST: Update Definition…',
    category: 'Explorer',
  },
  'grpc.send': {
    id: 'grpc.send',
    label: 'Send gRPC Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'grpc.copyAsCommand': {
    id: 'grpc.copyAsCommand',
    label: 'gRPC: Copy as Command',
    category: 'Request',
  },
  'grpc.importProto': {
    id: 'grpc.importProto',
    label: 'gRPC: Import .proto…',
    category: 'Definition',
  },
  'grpc.newApi': {
    id: 'grpc.newApi',
    label: 'gRPC: New API',
    category: 'Explorer',
  },
  'grpc.newRequest': {
    id: 'grpc.newRequest',
    label: 'gRPC: New Request',
    category: 'Explorer',
  },
  'ws.newApi': {
    id: 'ws.newApi',
    label: 'WebSocket: New API',
    category: 'Explorer',
  },
  'ws.newRequest': {
    id: 'ws.newRequest',
    label: 'WebSocket: New Request',
    category: 'Explorer',
  },
  // One chord for the tab's next step: it connects a closed session and, once the session is
  // open, sends the selected saved message. The composer keeps `Mod+Enter` for itself.
  'ws.connect': {
    id: 'ws.connect',
    label: 'WebSocket: Connect or Send Selected Message',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'ws.disconnect': {
    id: 'ws.disconnect',
    label: 'WebSocket: Disconnect',
    category: 'Request',
  },
  'ws.sendMessage': {
    id: 'ws.sendMessage',
    label: 'WebSocket: Send Selected Message',
    category: 'Request',
  },
  'ws.copyAsCommand': {
    id: 'ws.copyAsCommand',
    label: 'WebSocket: Copy as Command',
    category: 'Request',
  },
  'env.switch': {
    id: 'env.switch',
    label: 'Switch Environment…',
    category: 'Environment',
  },
  'env.next': {
    id: 'env.next',
    label: 'Next Environment',
    category: 'Environment',
    shortcut: 'Mod+Alt+E',
  },
  'secrets.toggleShowSecrets': {
    id: 'secrets.toggleShowSecrets',
    label: 'Toggle Show Secrets in HTTP Log',
    category: 'Secrets',
  },
  'secrets.setTokenValue': {
    id: 'secrets.setTokenValue',
    label: 'Set Secret Token Value…',
    category: 'Secrets',
  },
  'request.send': {
    id: 'request.send',
    label: 'Send Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'request.cancel': {
    id: 'request.cancel',
    label: 'Cancel Request',
    category: 'Request',
    shortcut: 'Escape',
  },
  'request.sendToEnvironments': {
    id: 'request.sendToEnvironments',
    label: 'Request: Send to Environments…',
    category: 'Request',
  },
  'request.recreateKeepValues': {
    id: 'request.recreateKeepValues',
    label: 'Request: Recreate (keep values)',
    category: 'Request',
  },
  'request.recreateDiscardValues': {
    id: 'request.recreateDiscardValues',
    label: 'Request: Recreate (discard values)',
    category: 'Request',
  },
  'request.createEmpty': {
    id: 'request.createEmpty',
    label: 'Request: Create Empty Envelope',
    category: 'Request',
  },
  'request.clone': {
    id: 'request.clone',
    label: 'Request: Clone…',
    category: 'Request',
  },
  'request.copyCurl': {
    id: 'request.copyCurl',
    label: 'Request: Copy as cURL',
    category: 'Request',
  },
  'request.copyCurlPowerShell': {
    id: 'request.copyCurlPowerShell',
    label: 'Request: Copy as cURL (PowerShell)',
    category: 'Request',
  },
  'request.importCurl': {
    id: 'request.importCurl',
    label: 'Request: Import cURL…',
    category: 'Request',
  },
  'request.showCode': {
    id: 'request.showCode',
    label: 'Request: Show Code',
    category: 'Request',
  },
  'request.addWssUsernameToken': {
    id: 'request.addWssUsernameToken',
    label: 'Request: Add WSS Username Token…',
    category: 'Request',
  },
  'request.addWsTimestamp': {
    id: 'request.addWsTimestamp',
    label: 'Request: Add WS-Timestamp…',
    category: 'Request',
  },
  'request.applyOutgoingWss': {
    id: 'request.applyOutgoingWss',
    label: 'Request: Outgoing WSS → Apply to Editor',
    category: 'Request',
  },
  'request.removeOutgoingWss': {
    id: 'request.removeOutgoingWss',
    label: 'Request: Outgoing WSS → Remove',
    category: 'Request',
  },
  'request.addWsaHeaders': {
    id: 'request.addWsaHeaders',
    label: 'Request: WS-A Headers → Add to Editor',
    category: 'Request',
  },
  'request.removeWsaHeaders': {
    id: 'request.removeWsaHeaders',
    label: 'Request: WS-A Headers → Remove',
    category: 'Request',
  },
  'request.addAttachment': {
    id: 'request.addAttachment',
    label: 'Request: Add Attachment…',
    category: 'Request',
  },
  'request.removeAttachment': {
    id: 'request.removeAttachment',
    label: 'Request: Remove Attachment',
    category: 'Request',
  },
  'request.validate': {
    id: 'request.validate',
    label: 'Validate Request',
    category: 'Request',
    shortcut: 'Mod+Shift+V',
  },
  'response.validate': {
    id: 'response.validate',
    label: 'Validate Response',
    category: 'Request',
  },
  'request.checkWsi': {
    id: 'request.checkWsi',
    label: 'Check WS-I compliance',
    category: 'Request',
  },
  'editor.formatXml': {
    id: 'editor.formatXml',
    label: 'Format Document',
    category: 'Editor',
    shortcut: 'Mod+Shift+F',
  },
  'editor.gotoLine': {
    id: 'editor.gotoLine',
    label: 'Go to Line…',
    category: 'Editor',
  },
  'editor.goToSchemaDefinition': {
    id: 'editor.goToSchemaDefinition',
    label: 'Go to Schema Definition',
    category: 'Editor',
  },
  'editor.toggleLineNumbers': {
    id: 'editor.toggleLineNumbers',
    label: 'Toggle Line Numbers',
    category: 'Editor',
  },
  'editor.saveAs': {
    id: 'editor.saveAs',
    label: 'Save Request As…',
    category: 'Editor',
  },
  'editor.loadFrom': {
    id: 'editor.loadFrom',
    label: 'Load Request From…',
    category: 'Editor',
  },
  'editor.toggleLayoutOrientation': {
    id: 'editor.toggleLayoutOrientation',
    label: 'Toggle Editor Layout: Side by Side / Stacked',
    category: 'Editor',
  },
  'editor.toggleLayoutMode': {
    id: 'editor.toggleLayoutMode',
    label: 'Toggle Editor Layout: Split / Tabs',
    category: 'Editor',
    shortcut: 'Mod+Backslash',
  },
  'editor.closeTab': {
    id: 'editor.closeTab',
    label: 'Close Tab',
    category: 'Editor',
    shortcut: 'Mod+W',
  },
  'editor.moveTabLeft': {
    id: 'editor.moveTabLeft',
    label: 'Move Tab Left',
    category: 'Editor',
    shortcut: 'Mod+Shift+PageUp',
  },
  'editor.moveTabRight': {
    id: 'editor.moveTabRight',
    label: 'Move Tab Right',
    category: 'Editor',
    shortcut: 'Mod+Shift+PageDown',
  },
  'editor.nextValue': {
    id: 'editor.nextValue',
    label: 'Go to Next Element Value',
    category: 'Editor',
    shortcut: 'Alt+Right',
  },
  'editor.previousValue': {
    id: 'editor.previousValue',
    label: 'Go to Previous Element Value',
    category: 'Editor',
    shortcut: 'Alt+Left',
  },
  'editor.focusOtherPane': {
    id: 'editor.focusOtherPane',
    label: 'Focus Request / Response Editor',
    category: 'Editor',
    shortcut: 'Shift+Tab',
  },
  // The request pane's four views, as `view.request*` commands. Ship without chords — the
  // design's §5 table spends every free one — but they are commands so the palette, the menu
  // and a user rebind can reach them.
  'view.requestXml': {
    id: 'view.requestXml',
    label: 'Request: XML View',
    category: 'View',
  },
  'view.requestForm': {
    id: 'view.requestForm',
    label: 'Request: Form View',
    category: 'View',
  },
  'view.requestOutline': {
    id: 'view.requestOutline',
    label: 'Request: Outline View',
    category: 'View',
  },
  'view.requestRaw': {
    id: 'view.requestRaw',
    label: 'Request: Raw View',
    category: 'View',
  },
  // The response pane's four selectable views (the Fault tab is revealed, never chosen).
  'view.responseXml': {
    id: 'view.responseXml',
    label: 'Response: XML View',
    category: 'View',
  },
  'view.responseOutline': {
    id: 'view.responseOutline',
    label: 'Response: Outline View',
    category: 'View',
  },
  'view.responseRaw': {
    id: 'view.responseRaw',
    label: 'Response: Raw View',
    category: 'View',
  },
  'view.responseQuery': {
    id: 'view.responseQuery',
    label: 'Response: Query View',
    category: 'View',
  },
  // None of the three below ships with a chord: the design's §5 table has no row for them, and
  // inventing one here would quietly take a key away from the user's own bindings.
  'history.resend': {
    id: 'history.resend',
    label: 'History: Re-send Last SOAP Request',
    category: 'History',
  },
  'history.compare': {
    id: 'history.compare',
    label: 'History: Compare Last Two Sends',
    category: 'History',
  },
  'history.clear': {
    id: 'history.clear',
    label: 'History: Delete All Entries',
    category: 'History',
  },
  'request.exportWsiReport': {
    id: 'request.exportWsiReport',
    label: 'Export WS-I Report…',
    category: 'Request',
  },
  'sync.pull': {
    id: 'sync.pull',
    label: 'Sync: Pull',
    category: 'Sync',
    shortcut: 'Mod+Alt+L',
  },
  'sync.push': {
    id: 'sync.push',
    label: 'Sync: Push',
    category: 'Sync',
    shortcut: 'Mod+Alt+U',
  },
  'sync.fetch': {
    id: 'sync.fetch',
    label: 'Sync: Fetch',
    category: 'Sync',
  },
  'sync.commit': {
    id: 'sync.commit',
    label: 'Sync: Commit',
    category: 'Sync',
  },
  'sync.resolveConflicts': {
    id: 'sync.resolveConflicts',
    label: 'Sync: Resolve Conflicts…',
    category: 'Sync',
  },
  'sync.openPanel': {
    id: 'sync.openPanel',
    label: 'Sync: Show Sync Panel',
    category: 'Sync',
  },
  'sync.revealTree': {
    id: 'sync.revealTree',
    label: 'Sync: Reveal Shared Folder',
    category: 'Sync',
  },
  'workspace.share': {
    id: 'workspace.share',
    label: 'Share Workspace…',
    category: 'Workspace',
  },
  'workspace.join': {
    id: 'workspace.join',
    label: 'Join Shared Workspace…',
    category: 'Workspace',
  },
  'workspace.stopSharing': {
    id: 'workspace.stopSharing',
    label: 'Stop Sharing',
    category: 'Workspace',
  },
  'project.moveToWorkspace': {
    id: 'project.moveToWorkspace',
    label: 'Move to Workspace…',
    category: 'Project',
  },
};

/** `COMMAND_CATALOG[id]`, typed so a spread at a call site needs no cast. */
export function catalogEntry(id: CommandId): CommandCatalogEntry {
  return COMMAND_CATALOG[id];
}
