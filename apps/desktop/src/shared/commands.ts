/**
 * The command vocabulary shared by the renderer's registry, the palette, menus, and (later)
 * the main process. Every user-facing action in Wirebench is addressed by one of these ids.
 */
export type CommandId =
  | 'palette.open'
  | 'view.toggleSidebar'
  | 'view.toggleConsole'
  | 'view.toggleDetails'
  | 'view.showExplorer'
  | 'view.showSearch'
  | 'view.showHistory'
  | 'view.showWss'
  | 'view.showSettings'
  | 'view.toggleTheme'
  | 'preferences.open'
  | 'definition.import'
  | 'project.new'
  | 'project.open'
  | 'project.save'
  | 'project.close'
  | 'explorer.importAnother'
  | 'explorer.removeInterface'
  | 'explorer.showInterface'
  | 'explorer.copyDefinitionUrl'
  | 'explorer.newRequest'
  | 'explorer.copySoapAction'
  | 'explorer.openRequest'
  | 'explorer.cloneRequest'
  | 'explorer.renameRequest'
  | 'explorer.deleteRequest'
  | 'explorer.recreateRequest'
  | 'explorer.copyEndpointAddress'
  | 'explorer.checkWsiWsdl'
  | 'env.switch'
  | 'env.next'
  | 'secrets.toggleShowSecrets'
  | 'request.send'
  | 'request.cancel'
  | 'request.recreateKeepValues'
  | 'request.recreateDiscardValues'
  | 'request.createEmpty'
  | 'request.clone'
  | 'request.copyCurl'
  | 'request.copyCurlPowerShell'
  | 'request.importCurl'
  | 'request.showCode'
  | 'request.addWssUsernameToken'
  | 'request.addWsTimestamp'
  | 'request.applyOutgoingWss'
  | 'request.removeOutgoingWss'
  | 'request.addWsaHeaders'
  | 'request.removeWsaHeaders'
  | 'request.addAttachment'
  | 'request.removeAttachment'
  | 'request.validate'
  | 'response.validate'
  | 'request.checkWsi'
  | 'editor.formatXml'
  | 'editor.gotoLine'
  | 'editor.toggleLineNumbers'
  | 'editor.saveAs'
  | 'editor.loadFrom'
  | 'editor.toggleLayoutOrientation'
  | 'editor.toggleLayoutMode';

/** Palette grouping for a command; also the heading shown in the command palette. */
export type CommandCategory =
  'General' | 'View' | 'Project' | 'Definition' | 'Explorer' | 'Environment' | 'Request' | 'Secrets' | 'Editor';

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
  readonly when?: (context: Ctx) => boolean;
}
