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
  'view.showSettings',
  'view.toggleTheme',
  'preferences.open',
  'definition.import',
  'definition.importLegacyProject',
  'item.save',
  'project.save',
  'workspace.create',
  'workspace.switch',
  'workspace.manage',
  'workspace.newProject',
  'workspace.linkProject',
  'workspace.importProjectFolder',
  'workspace.exportProject',
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
  'rest.importOpenApi',
  'rest.importPostman',
  'rest.newApi',
  'rest.newFolder',
  'rest.newRequest',
  'rest.updateDefinition',
  'grpc.send',
  'grpc.copyAsCommand',
  'grpc.importProto',
  'grpc.newApi',
  'grpc.newRequest',
  'ws.newApi',
  'ws.newRequest',
  'ws.connect',
  'ws.disconnect',
  'ws.sendMessage',
  'ws.copyAsCommand',
  'env.switch',
  'env.next',
  'secrets.toggleShowSecrets',
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
  'workspace.stopSharing',
  'project.moveToWorkspace',
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
  | 'Sync';

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
  project: 'a project is open',
  'project.environments': 'the project has environments',
  'selection.project': 'a project is selected',
  'selection.interface': 'an interface is selected',
  'selection.operation': 'an operation is selected',
  'selection.request': 'a request is selected',
  'selection.endpoint': 'an endpoint is selected',
  'selection.api': 'an API, a folder or a REST request is selected',
  'selection.grpcApi': 'a gRPC API, a folder in one or a gRPC request is selected',
  'selection.wsApi': 'a WebSocket API, a folder in one or a WebSocket request is selected',
  'wsi.report': 'a WS-I report has been run',
  'history.entries': 'the history has entries',
  'history.pair': 'the history has two or more entries',
  'workspace.shared': 'the open workspace is shared',
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
  readonly when?: (context: Ctx) => boolean;
  /**
   * The declared identity of `when`, so two gated commands can be compared without calling
   * their closures. Required wherever `when` is set (the registry audit enforces it).
   */
  readonly whenScope?: CommandWhenScope;
}
