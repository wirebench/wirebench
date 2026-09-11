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
  'palette.open',
  'palette.quickOpen',
  'view.toggleSidebar',
  'view.toggleConsole',
  'view.toggleDetails',
  'view.showExplorer',
  'view.showSearch',
  'view.showHistory',
  'view.showWss',
  'view.showSettings',
  'view.toggleTheme',
  'preferences.open',
  'definition.import',
  'project.new',
  'project.open',
  'project.save',
  'project.close',
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
  'env.switch',
  'env.next',
  'secrets.toggleShowSecrets',
  'request.send',
  'request.cancel',
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
  'editor.nextValue',
  'editor.previousValue',
  'editor.focusOtherPane',
] as const;

/** Every addressable action. Derived from {@link COMMAND_IDS} so the two can never drift. */
export type CommandId = (typeof COMMAND_IDS)[number];

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
  /**
   * Further chords that also run this command. The design gives the palette two (⌘K and ⌘⇧P);
   * only `shortcut` is ever shown in the UI or offered to the menu, and only `shortcut` can be
   * rebound — these are fixed aliases.
   */
  readonly extraShortcuts?: readonly string[];
  readonly when?: (context: Ctx) => boolean;
}
