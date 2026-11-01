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
  /**
   * Left out of the palette and the command reference: a command menus run with an argument
   * (a host, a snippet), whose bare form a palette twin already covers. Keybindings still reach it.
   */
  readonly paletteHidden?: boolean;
  /**
   * A CSS selector the focused element must sit inside for the shortcut to fire. For a key that means
   * something else elsewhere (Delete in the Explorer tree): the palette and the menus still run the
   * command from anywhere. Unset, the shortcut fires wherever the command's `when` holds.
   */
  readonly keyScope?: string;
  /** Other words the palette finds the command by ("keys" for Keyboard Shortcuts); never shown. */
  readonly aliases?: readonly string[];
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
/** The Explorer tree: where its bare keys (Delete, F2) fire from, and nowhere else. */
export const EXPLORER_TREE = '[role="tree"][aria-label="Explorer"]';

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
  'view.showHosts': {
    id: 'view.showHosts',
    label: 'Show Hosts',
    category: 'View',
  },
  'view.showForwarding': {
    id: 'view.showForwarding',
    label: 'Show Port Forwarding',
    category: 'View',
  },
  'view.showSnippets': {
    id: 'view.showSnippets',
    label: 'Show Snippets',
    category: 'View',
  },
  'ssh.newHost': {
    id: 'ssh.newHost',
    label: 'Hosts: New Host…',
    category: 'Hosts',
  },
  'ssh.newGroup': {
    id: 'ssh.newGroup',
    label: 'Hosts: New Host Group…',
    category: 'Hosts',
  },
  'ssh.editHost': {
    id: 'ssh.editHost',
    label: 'Hosts: Edit Host…',
    category: 'Hosts',
  },
  'ssh.importConfig': {
    id: 'ssh.importConfig',
    label: 'Hosts: Import Hosts…',
    category: 'Hosts',
  },
  'ssh.importKnownHosts': {
    id: 'ssh.importKnownHosts',
    label: 'Hosts: Import Known Hosts…',
    category: 'Hosts',
  },
  'ssh.connect': {
    id: 'ssh.connect',
    label: 'Hosts: Connect to Host',
    category: 'Hosts',
    paletteHidden: true,
  },
  'ssh.connectPalette': {
    id: 'ssh.connectPalette',
    label: 'Hosts: Connect to Host…',
    category: 'Hosts',
    shortcut: 'Mod+Shift+H',
  },
  'ssh.openFiles': {
    id: 'ssh.openFiles',
    label: 'Hosts: Open Files on Host…',
    category: 'Hosts',
  },
  'ssh.openInNewTab': {
    id: 'ssh.openInNewTab',
    label: 'Hosts: Open Host in New Tab…',
    category: 'Hosts',
  },
  'ssh.openLayout': {
    id: 'ssh.openLayout',
    label: 'Layouts: Open Layout…',
    category: 'Hosts',
  },
  'ssh.saveLayout': {
    id: 'ssh.saveLayout',
    label: 'Layouts: Save Layout…',
    category: 'Hosts',
  },
  'ssh.toggleBroadcast': {
    id: 'ssh.toggleBroadcast',
    label: 'Terminal: Toggle Broadcast Input',
    category: 'Hosts',
  },
  'ssh.splitRight': {
    id: 'ssh.splitRight',
    label: 'Terminal: Split Right',
    category: 'Hosts',
    shortcut: 'Mod+D',
  },
  'ssh.splitDown': {
    id: 'ssh.splitDown',
    label: 'Terminal: Split Down',
    category: 'Hosts',
    shortcut: 'Mod+Shift+D',
  },
  'ssh.focusPaneLeft': {
    id: 'ssh.focusPaneLeft',
    label: 'Terminal: Focus Pane Left',
    category: 'Hosts',
    shortcut: 'Mod+Alt+Left',
  },
  'ssh.focusPaneRight': {
    id: 'ssh.focusPaneRight',
    label: 'Terminal: Focus Pane Right',
    category: 'Hosts',
    shortcut: 'Mod+Alt+Right',
  },
  'ssh.focusPaneUp': {
    id: 'ssh.focusPaneUp',
    label: 'Terminal: Focus Pane Above',
    category: 'Hosts',
    shortcut: 'Mod+Alt+Up',
  },
  'ssh.focusPaneDown': {
    id: 'ssh.focusPaneDown',
    label: 'Terminal: Focus Pane Below',
    category: 'Hosts',
    shortcut: 'Mod+Alt+Down',
  },
  // No chord of its own: ⌘W closes the focused pane of a split tab (see `editor.closeTab`).
  'ssh.closePane': {
    id: 'ssh.closePane',
    label: 'Terminal: Close Pane',
    category: 'Hosts',
  },
  'ssh.startForward': {
    id: 'ssh.startForward',
    label: 'Forwarding: Start Port Forward…',
    category: 'Forwarding',
  },
  'ssh.stopForward': {
    id: 'ssh.stopForward',
    label: 'Forwarding: Stop Port Forward…',
    category: 'Forwarding',
  },
  'ssh.stopAllForwards': {
    id: 'ssh.stopAllForwards',
    label: 'Forwarding: Stop All Port Forwards',
    category: 'Forwarding',
  },
  'ssh.startForwardGroup': {
    id: 'ssh.startForwardGroup',
    label: 'Forwarding: Start Forwarding Group…',
    category: 'Forwarding',
  },
  'ssh.stopForwardGroup': {
    id: 'ssh.stopForwardGroup',
    label: 'Forwarding: Stop Forwarding Group…',
    category: 'Forwarding',
  },
  'ssh.newSnippet': {
    id: 'ssh.newSnippet',
    label: 'Snippets: New Snippet…',
    category: 'Hosts',
  },
  'ssh.editSnippet': {
    id: 'ssh.editSnippet',
    label: 'Snippets: Edit Snippet…',
    category: 'Hosts',
  },
  // From a menu or a row it names the snippet; from the palette it asks which one, like Run Snippet….
  'ssh.runSnippet': {
    id: 'ssh.runSnippet',
    label: 'Snippets: Run Snippet',
    category: 'Hosts',
    paletteHidden: true,
  },
  'ssh.runSnippetPalette': {
    id: 'ssh.runSnippetPalette',
    label: 'Snippets: Run Snippet…',
    category: 'Hosts',
  },
  // Ctrl+; on Windows and Linux; caught in the terminal so the shell never sees it.
  'ssh.snippetPicker': {
    id: 'ssh.snippetPicker',
    label: 'Terminal: Snippets…',
    category: 'Hosts',
    shortcut: 'Mod+Semicolon',
  },
  'ssh.newLocalTerminal': {
    id: 'ssh.newLocalTerminal',
    label: 'Terminal: New Local Terminal',
    category: 'Hosts',
    shortcut: 'Mod+Alt+T',
  },
  // Every host's session logs on this machine (#534); a host's own are in its details panel.
  'ssh.sessionLogs': {
    id: 'ssh.sessionLogs',
    label: 'Terminal: Session Logs…',
    category: 'Hosts',
  },
  // The workspace server's session logs, every member's (#430).
  'ssh.teamSessionLogs': {
    id: 'ssh.teamSessionLogs',
    label: 'Terminal: Team Session Logs…',
    category: 'Hosts',
  },
  // A teammate's shared terminal, from the invite link they copied (#429).
  'ssh.joinShare': {
    id: 'ssh.joinShare',
    label: 'Terminal: Join Shared Terminal…',
    category: 'Hosts',
  },
  'sftp.refresh': {
    id: 'sftp.refresh',
    label: 'Files: Refresh',
    category: 'Hosts',
  },
  'sftp.newFolder': {
    id: 'sftp.newFolder',
    label: 'Files: New Folder',
    category: 'Hosts',
  },
  'sftp.rename': {
    id: 'sftp.rename',
    label: 'Files: Rename',
    category: 'Hosts',
  },
  'sftp.delete': {
    id: 'sftp.delete',
    label: 'Files: Delete…',
    category: 'Hosts',
  },
  'sftp.permissions': {
    id: 'sftp.permissions',
    label: 'Files: Permissions…',
    category: 'Hosts',
  },
  'sftp.copyToOtherPane': {
    id: 'sftp.copyToOtherPane',
    label: 'Files: Copy to Other Pane',
    category: 'Hosts',
  },
  'sftp.toggleHidden': {
    id: 'sftp.toggleHidden',
    label: 'Files: Show or Hide Hidden Files',
    category: 'Hosts',
  },
  'sftp.focusPathBar': {
    id: 'sftp.focusPathBar',
    label: 'Files: Go to Folder…',
    category: 'Hosts',
    shortcut: 'Mod+L',
  },
  'view.showCookies': {
    id: 'view.showCookies',
    label: 'Show Cookies',
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
  'view.choosePalette': {
    id: 'view.choosePalette',
    label: 'Theme: choose colour theme…',
    category: 'View',
  },
  'preferences.open': {
    id: 'preferences.open',
    label: 'Open Preferences',
    category: 'General',
  },
  'preferences.keyboardShortcuts': {
    id: 'preferences.keyboardShortcuts',
    label: 'Preferences: Keyboard Shortcuts',
    category: 'General',
    aliases: ['keys', 'bindings', 'keybindings'],
  },
  'definition.import': {
    id: 'definition.import',
    label: 'Import…',
    category: 'Definition',
    shortcut: 'Mod+I',
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
  'workspace.secretSources': {
    id: 'workspace.secretSources',
    label: 'Secret Sources…',
    category: 'Workspace',
  },
  'workspace.checkCertificates': {
    id: 'workspace.checkCertificates',
    label: 'Check Certificate Expiry',
    category: 'Workspace',
  },
  'workspace.newProject': {
    id: 'workspace.newProject',
    label: 'New Project…',
    category: 'Workspace',
    shortcut: 'Mod+Shift+N',
  },
  'workspace.newWindow': {
    id: 'workspace.newWindow',
    label: 'New Window',
    category: 'Workspace',
    shortcut: 'Mod+Alt+N',
  },
  'workspace.linkProject': {
    id: 'workspace.linkProject',
    label: 'Link Project Folder…',
    category: 'Workspace',
  },
  'workspace.importProjectFolder': {
    id: 'workspace.importProjectFolder',
    label: 'Add Project Folder to Workspace…',
    category: 'Workspace',
  },
  'workspace.exportProject': {
    id: 'workspace.exportProject',
    label: 'Export Project…',
    category: 'Workspace',
  },
  'workspace.exportPostman': {
    id: 'workspace.exportPostman',
    label: 'Export Project as Postman Collection…',
    category: 'Workspace',
  },
  'workspace.exportOpenCollection': {
    id: 'workspace.exportOpenCollection',
    label: 'Export Project as OpenCollection…',
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
  'explorer.collapseAll': {
    id: 'explorer.collapseAll',
    label: 'Explorer: Collapse All',
    category: 'Explorer',
  },
  'explorer.expandAll': {
    id: 'explorer.expandAll',
    label: 'Explorer: Expand All',
    category: 'Explorer',
  },
  'explorer.revealActiveTab': {
    id: 'explorer.revealActiveTab',
    label: 'Explorer: Reveal Active Tab',
    category: 'Explorer',
  },
  'explorer.focus': {
    id: 'explorer.focus',
    label: 'Explorer: Focus Explorer',
    category: 'Explorer',
  },
  'explorer.rename': {
    id: 'explorer.rename',
    label: 'Explorer: Rename',
    category: 'Explorer',
    // F2 is the desktop's rename key; Enter renames too, from the tree's own key handling, as it always has.
    shortcut: 'F2',
    keyScope: EXPLORER_TREE,
  },
  'explorer.duplicate': {
    id: 'explorer.duplicate',
    label: 'Explorer: Duplicate',
    category: 'Explorer',
  },
  'explorer.delete': {
    id: 'explorer.delete',
    label: 'Explorer: Delete',
    category: 'Explorer',
    // Delete is the key; ⌘⌫ (Ctrl+Backspace elsewhere) and plain Backspace are the tree's own aliases,
    // handled inside it, so they never reach a text field.
    shortcut: 'Delete',
    extraShortcuts: ['Mod+Backspace'],
    keyScope: EXPLORER_TREE,
  },
  'explorer.newFolder': {
    id: 'explorer.newFolder',
    label: 'Explorer: New Folder',
    category: 'Explorer',
  },
  'rest.send': {
    id: 'rest.send',
    label: 'REST: Send Request',
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
  'rest.lintDefinition': {
    id: 'rest.lintDefinition',
    label: 'REST: Lint Definition',
    category: 'Explorer',
  },
  'grpc.send': {
    id: 'grpc.send',
    label: 'gRPC: Send Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'grpc.copyAsCommand': {
    id: 'grpc.copyAsCommand',
    label: 'gRPC: Copy as Command',
    category: 'Request',
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
  'mcp.newServer': {
    id: 'mcp.newServer',
    label: 'MCP: New Server',
    category: 'Explorer',
  },
  'mcp.newRequest': {
    id: 'mcp.newRequest',
    label: 'MCP: New Request',
    category: 'Explorer',
  },
  'mcp.refreshCatalogue': {
    id: 'mcp.refreshCatalogue',
    label: 'MCP: Refresh Catalogue',
    category: 'Explorer',
  },
  'mcp.newRequestFromTool': {
    id: 'mcp.newRequestFromTool',
    label: 'MCP: New Request from Tool',
    category: 'Explorer',
  },
  // The chord every request editor sends with; an MCP tab is none of theirs.
  'mcp.send': {
    id: 'mcp.send',
    label: 'MCP: Send Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'mcp.cancel': {
    id: 'mcp.cancel',
    label: 'MCP: Cancel Request',
    category: 'Request',
  },
  'sequence.new': {
    id: 'sequence.new',
    label: 'Sequence: New Sequence',
    category: 'Explorer',
  },
  // The tab's one action, on the chord every editor sends with; a sequence tab is none of theirs.
  'sequence.run': {
    id: 'sequence.run',
    label: 'Sequence: Run',
    category: 'Request',
    shortcut: 'Mod+Enter',
  },
  'sequence.cancel': {
    id: 'sequence.cancel',
    label: 'Sequence: Cancel Run',
    category: 'Request',
  },
  // The Runner (#336): the selected row run once per iteration, with a data file.
  'runner.open': {
    id: 'runner.open',
    label: 'Runner: Run Selection…',
    category: 'Explorer',
  },
  // A mock tab's server (#59): served from this machine until it is stopped or its project closes.
  'mock.start': {
    id: 'mock.start',
    label: 'Mock: Start',
    category: 'Request',
  },
  'mock.stop': {
    id: 'mock.stop',
    label: 'Mock: Stop',
    category: 'Request',
  },
  // A project's session values (#63): what single sends' scripts set, kept until the project closes.
  'script.clearValues': {
    id: 'script.clearValues',
    label: 'Scripts: Clear Session Values',
    category: 'Explorer',
  },
  // Every imported script of the current project, rewritten to the typed API after a review.
  'script.convertAll': {
    id: 'script.convertAll',
    label: 'Scripts: Convert All Imported Scripts…',
    category: 'Explorer',
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
  // "HTTP Log" in the palette should land on the log itself, not on the command that reveals
  // credentials in it: this one ranks first for that search.
  'view.showHttpLog': {
    id: 'view.showHttpLog',
    label: 'Show HTTP Log',
    category: 'View',
  },
  // Kept under its old id so a key someone bound to it still works; it now asks before revealing.
  'secrets.toggleShowSecrets': {
    id: 'secrets.toggleShowSecrets',
    label: 'Reveal Secrets in HTTP Log…',
    category: 'Secrets',
  },
  'secrets.setTokenValue': {
    id: 'secrets.setTokenValue',
    label: 'Set Secret Token Value…',
    category: 'Secrets',
  },
  'secrets.clearSourceCache': {
    id: 'secrets.clearSourceCache',
    label: 'Clear Secret Source Cache',
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
  // The tab menu's close actions (#679), for the palette and a user's own chords.
  'editor.closeOtherTabs': {
    id: 'editor.closeOtherTabs',
    label: 'Close Other Tabs',
    category: 'Editor',
  },
  'editor.closeTabsToRight': {
    id: 'editor.closeTabsToRight',
    label: 'Close Tabs to the Right',
    category: 'Editor',
  },
  'editor.closeSavedTabs': {
    id: 'editor.closeSavedTabs',
    label: 'Close Saved Tabs',
    category: 'Editor',
  },
  'editor.closeAllTabs': {
    id: 'editor.closeAllTabs',
    label: 'Close All Tabs',
    category: 'Editor',
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
    label: 'History: Re-send Last Request',
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
  'workspace.openTeamWorkspace': {
    id: 'workspace.openTeamWorkspace',
    label: 'Open Team Workspace…',
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
  'account.signIn': {
    id: 'account.signIn',
    label: 'Account: Sign in to a server…',
    category: 'Account',
  },
  'account.pairThisMachine': {
    id: 'account.pairThisMachine',
    label: 'Pair this machine…',
    category: 'Account',
    aliases: ['agent', 'browser', 'pairing code'],
  },
  'account.signOut': {
    id: 'account.signOut',
    label: 'Account: Sign out…',
    category: 'Account',
  },
  'team.manage': {
    id: 'team.manage',
    label: 'Account: Manage teams…',
    category: 'Account',
  },
};

/** `COMMAND_CATALOG[id]`, typed so a spread at a call site needs no cast. */
export function catalogEntry(id: CommandId): CommandCatalogEntry {
  return COMMAND_CATALOG[id];
}

/** The SSH area's own views; every `ssh.*` and `sftp.*` command belongs to the area too. */
const SSH_AREA_VIEWS: ReadonlySet<string> = new Set(['view.showHosts', 'view.showForwarding', 'view.showSnippets']);

/**
 * Names a search can find a command by beyond its category and label: "ssh" for each command of the SSH
 * area, whose categories (Hosts, Forwarding, Terminal, Snippets) never say so.
 */
export function areaKeywords(id: string): readonly string[] {
  return /^(?:ssh|sftp)\./.test(id) || SSH_AREA_VIEWS.has(id) ? ['ssh'] : [];
}

/**
 * The other protocols a host can use (#425, #426, #419): a search for one names the commands that make
 * or open such a host, whose labels say only "Host" (S40).
 */
const PROTOCOL_KEYWORDS: Readonly<Record<string, readonly string[]>> = {
  'ssh.newHost': ['telnet', 'serial', 'mosh'],
  'ssh.connectPalette': ['telnet', 'serial', 'mosh'],
  // The everyday SOAP actions, whose labels say "Request" or "WSDL" but never "SOAP" (#732 X16).
  'explorer.importAnother': ['soap', 'wsdl'],
  'explorer.newRequest': ['soap'],
  'explorer.updateDefinition': ['soap', 'wsdl'],
  'request.send': ['soap'],
  'request.validate': ['soap'],
};

/** The protocol names a search can find a command by, beyond its category, label and area. */
export function protocolKeywords(id: string): readonly string[] {
  return PROTOCOL_KEYWORDS[id] ?? [];
}

/** The SSH area's main actions, which a search for the area's name ("ssh") lists first. */
const SSH_AREA_LEADS: ReadonlySet<string> = new Set(['ssh.connectPalette', 'ssh.newHost']);

/** SOAP's everyday actions, which a search for "soap" lists first (#732 X16). */
const SOAP_LEADS: ReadonlySet<string> = new Set([
  'explorer.importAnother',
  'explorer.newRequest',
  'explorer.updateDefinition',
  'request.send',
  'request.validate',
]);

/** Whether a command is one of its area's main actions, ranked first when a search names the area. */
export function isAreaLead(id: string): boolean {
  return SSH_AREA_LEADS.has(id) || SOAP_LEADS.has(id);
}
