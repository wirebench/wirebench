/**
 * The command vocabulary shared by the renderer's registry, the palette, the generated
 * application menu, and the main process. Every user-facing action in Wirebench is addressed
 * by one of these ids.
 *
 * {@link COMMAND_IDS} is the single source of truth and {@link CommandId} is derived from it,
 * so the registry audit (`test/renderer/command-registry.test.ts`) can enumerate every id at
 * runtime and prove each one has a handler, a label, a category and — where the design's
 * default shortcut table lists one — a default keybinding.
 */
export const COMMAND_IDS = [
  'app.checkForUpdates',
  'palette.open',
  'palette.quickOpen',
  'view.toggleSidebar',
  'view.toggleConsole',
  'view.toggleCode',
  'view.showExplorer',
  'view.showEnvironments',
  'view.showSearch',
  'view.showHistory',
  'view.showWss',
  'view.showHosts',
  'view.showForwarding',
  'view.showSnippets',
  'ssh.newHost',
  'ssh.newGroup',
  'ssh.editHost',
  'ssh.importConfig',
  'ssh.importKnownHosts',
  'ssh.connect',
  'ssh.connectPalette',
  'ssh.openFiles',
  'ssh.openInNewTab',
  'ssh.openLayout',
  'ssh.saveLayout',
  'ssh.toggleBroadcast',
  'ssh.splitRight',
  'ssh.splitDown',
  'ssh.focusPaneLeft',
  'ssh.focusPaneRight',
  'ssh.focusPaneUp',
  'ssh.focusPaneDown',
  'ssh.closePane',
  'ssh.startForward',
  'ssh.stopForward',
  'ssh.stopAllForwards',
  'ssh.startForwardGroup',
  'ssh.stopForwardGroup',
  'ssh.newSnippet',
  'ssh.editSnippet',
  'ssh.runSnippet',
  'ssh.runSnippetPalette',
  'ssh.snippetPicker',
  'ssh.newLocalTerminal',
  'ssh.sessionLogs',
  'ssh.teamSessionLogs',
  'ssh.joinShare',
  'sftp.refresh',
  'sftp.newFolder',
  'sftp.rename',
  'sftp.delete',
  'sftp.permissions',
  'sftp.copyToOtherPane',
  'sftp.toggleHidden',
  'sftp.focusPathBar',
  'view.showCookies',
  'view.showSettings',
  'view.toggleTheme',
  'preferences.open',
  'definition.import',
  'item.save',
  'project.save',
  'workspace.create',
  'workspace.switch',
  'workspace.manage',
  'workspace.secretSources',
  'workspace.checkCertificates',
  'workspace.newProject',
  'workspace.newWindow',
  'workspace.linkProject',
  'workspace.importProjectFolder',
  'workspace.exportProject',
  'workspace.exportPostman',
  'workspace.exportOpenCollection',
  'workspace.removeProject',
  'explorer.importAnother',
  'explorer.removeInterface',
  'explorer.showInterface',
  'explorer.updateDefinition',
  'explorer.exportDefinition',
  'explorer.generateDocs',
  'explorer.copyDefinitionUrl',
  'explorer.newRequest',
  'explorer.copySoapAction',
  'explorer.openRequest',
  'explorer.cloneRequest',
  'explorer.renameRequest',
  'explorer.deleteRequest',
  'explorer.recreateRequest',
  'explorer.copyEndpointAddress',
  'explorer.checkWsiWsdl',
  'rest.send',
  'rest.copyAsCurl',
  'rest.importCurl',
  'rest.getToken',
  'rest.newApi',
  'rest.newFolder',
  'rest.newRequest',
  'rest.updateDefinition',
  'rest.lintDefinition',
  'grpc.send',
  'grpc.copyAsCommand',
  'grpc.newApi',
  'grpc.newRequest',
  'ws.newApi',
  'ws.newRequest',
  'ws.connect',
  'ws.disconnect',
  'ws.sendMessage',
  'ws.copyAsCommand',
  'mcp.newServer',
  'mcp.newRequest',
  'mcp.refreshCatalogue',
  'mcp.newRequestFromTool',
  'mcp.send',
  'mcp.cancel',
  'sequence.new',
  'sequence.run',
  'sequence.cancel',
  'runner.open',
  'mock.start',
  'mock.stop',
  'script.clearValues',
  'env.switch',
  'env.next',
  'view.showHttpLog',
  'secrets.toggleShowSecrets',
  'secrets.setTokenValue',
  'secrets.clearSourceCache',
  'request.send',
  'request.cancel',
  'request.sendToEnvironments',
  'request.recreateKeepValues',
  'request.recreateDiscardValues',
  'request.createEmpty',
  'request.clone',
  'request.copyCurl',
  'request.copyCurlPowerShell',
  'request.importCurl',
  'request.showCode',
  'request.addWssUsernameToken',
  'request.addWsTimestamp',
  'request.applyOutgoingWss',
  'request.removeOutgoingWss',
  'request.addWsaHeaders',
  'request.removeWsaHeaders',
  'request.addAttachment',
  'request.removeAttachment',
  'request.validate',
  'response.validate',
  'request.checkWsi',
  'editor.formatXml',
  'editor.gotoLine',
  'editor.goToSchemaDefinition',
  'editor.toggleLineNumbers',
  'editor.saveAs',
  'editor.loadFrom',
  'editor.toggleLayoutOrientation',
  'editor.toggleLayoutMode',
  'editor.closeTab',
  'editor.closeOtherTabs',
  'editor.closeTabsToRight',
  'editor.closeSavedTabs',
  'editor.closeAllTabs',
  'editor.moveTabLeft',
  'editor.moveTabRight',
  'editor.nextValue',
  'editor.previousValue',
  'editor.focusOtherPane',
  'view.requestXml',
  'view.requestForm',
  'view.requestOutline',
  'view.requestRaw',
  'view.responseXml',
  'view.responseOutline',
  'view.responseRaw',
  'view.responseQuery',
  'history.resend',
  'history.compare',
  'history.clear',
  'request.exportWsiReport',
  'sync.pull',
  'sync.push',
  'sync.fetch',
  'sync.commit',
  'sync.resolveConflicts',
  'sync.openPanel',
  'sync.revealTree',
  'workspace.share',
  'workspace.join',
  'workspace.openTeamWorkspace',
  'workspace.stopSharing',
  'project.moveToWorkspace',
  'account.signIn',
  'account.signOut',
  'team.manage',
] as const;

/** Every addressable action. Derived from {@link COMMAND_IDS} so the two can never drift. */
export type CommandId = (typeof COMMAND_IDS)[number];

/** Palette grouping for a command; also the heading shown in the command palette. */
export type CommandCategory =
  | 'General'
  | 'View'
  | 'Workspace'
  | 'Project'
  | 'Definition'
  | 'Explorer'
  | 'Environment'
  | 'Request'
  | 'Secrets'
  | 'Editor'
  | 'History'
  | 'Hosts'
  | 'Forwarding'
  | 'Sync'
  | 'Account';

/**
 * The named conditions a command's `when` gate can stand for, and how each reads in a sentence.
 *
 * A `when` predicate is an opaque closure, so nothing can compare two of them; this table is
 * the declared identity of the condition behind one. Scopes are dotted paths and a dot means
 * "contained in": `editor.request` is a narrower condition than `editor`, so whenever the
 * narrower one holds the wider one does too. {@link whenScopesOverlap} is what the Shortcuts
 * editor uses to decide whether two commands on the same chord can ever both be live —
 * conflicts between conditions that can never hold at once are not conflicts.
 */
export const COMMAND_WHEN_SCOPES = {
  editor: 'an editor tab is open',
  workspace: 'a workspace is open',
  'editor.request': 'a request tab is active',
  'editor.rest': 'a REST request tab is active',
  'editor.grpc': 'a gRPC request tab is active',
  'editor.ws': 'a WebSocket request tab is active',
  'editor.mcp': 'an MCP request tab is active',
  'editor.sequence': 'a sequence tab is active',
  'editor.mock': 'a mock tab is active',
  'editor.files': 'a Files tab is active',
  'editor.terminal': 'a terminal tab is active',
  project: 'a project is open',
  'project.environments': 'the project has environments',
  'selection.project': 'a project is selected',
  'selection.interface': 'an interface is selected',
  'selection.operation': 'an operation is selected',
  'selection.request': 'a request is selected',
  'selection.endpoint': 'an endpoint is selected',
  'selection.api': 'a REST API, a folder in one or a REST request is selected, or a REST tab is active',
  'selection.grpcApi': 'a gRPC API, a folder in one or a gRPC request is selected, or a gRPC tab is active',
  'selection.wsApi':
    'a WebSocket API, a folder in one or a WebSocket request is selected, or a WebSocket tab is active',
  'selection.mcpApi': 'an MCP server, a folder in one or an MCP request is selected, or an MCP tab is active',
  'selection.mcpServer': 'an MCP server is selected',
  'selection.runnable': 'a project, an API, an interface, a folder, a REST request or a sequence is selected',
  'wsi.report': 'a WS-I report has been run',
  'history.entries': 'the history has entries',
  'history.pair': 'the history has two or more entries',
  'workspace.shared': 'the open workspace is shared',
  'account.signedIn': 'a server account is signed in',
  'area.code': 'the area in front has requests (not SSH or Environments)',
} as const;

/** The key half of {@link COMMAND_WHEN_SCOPES}. */
export type CommandWhenScope = keyof typeof COMMAND_WHEN_SCOPES;

/**
 * True when two `when` conditions can hold at the same moment: when either command is
 * ungated (`undefined`), when they declare the same scope, or when one scope is nested inside
 * the other (`editor.request` inside `editor`).
 */
export function whenScopesOverlap(a: CommandWhenScope | undefined, b: CommandWhenScope | undefined): boolean {
  if (a === undefined || b === undefined || a === b) {
    return true;
  }
  return a.startsWith(`${b}.`) || b.startsWith(`${a}.`);
}

/**
 * The declarative half of a command: everything needed to render it in a palette or a menu,
 * without knowing how it runs. `shortcut` is a keybinding string such as `Mod+Shift+E`.
 * `when` gates availability against a context the renderer supplies; a command with no
 * `when` is always available. Generic over the context so this module stays DOM-free.
 */
export interface CommandDefinition<Ctx = unknown> {
  readonly id: CommandId;
  readonly label: string;
  readonly category: CommandCategory;
  readonly shortcut?: string;
  /**
   * Further chords that also run this command. The design gives the palette two (⌘K and ⌘⇧P);
   * only `shortcut` is ever shown in the UI or offered to the menu, and only `shortcut` can be
   * rebound — these are fixed aliases.
   */
  readonly extraShortcuts?: readonly string[];
  /** Kept out of the palette; menus and keybindings still run it (see `CommandCatalogEntry`). */
  readonly paletteHidden?: boolean;
  readonly when?: (context: Ctx) => boolean;
  /**
   * The declared identity of `when`, so two gated commands can be compared without calling
   * their closures. Required wherever `when` is set (the registry audit enforces it).
   */
  readonly whenScope?: CommandWhenScope;
}
