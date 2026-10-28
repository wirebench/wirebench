import type { CommandDefinition, CommandId } from '@shared/commands.js';
import type { UiSnapshot } from '../state/ui-state.js';
import type { Selection } from '../state/ui.js';
import type { Platform } from './platform.js';
import { hasCapability, type Capability } from './capabilities.js';

/** What a command sees when it is listed, gated, or run. */
export interface CommandContext {
  readonly platform: Platform;
  /**
   * The layout a command can gate or toggle on. The per-workspace tab memory of
   * {@link UiSnapshot} is deliberately not part of it: no command reads it, and leaving it out
   * keeps a context cheap to build on every selection change.
   */
  readonly ui: Omit<UiSnapshot, 'workspaces'>;
  /** The explorer's current selection, if any — lets `explorer.*` commands gate on node kind. */
  readonly selection: Selection | undefined;
}

/** A command definition plus the handler that performs it. */
export interface Command extends CommandDefinition<CommandContext> {
  /** `arg` carries an optional command-specific payload (e.g. a URL for `definition.import`). */
  readonly run: (context: CommandContext, arg?: unknown) => void | Promise<void>;
  /**
   * Why the command cannot run here, for one the palette should list anyway: while `when` says no and this
   * gives a reason, the palette shows the command disabled with the reason rather than hiding it.
   */
  readonly unavailable?: (context: CommandContext) => string | undefined;
}

/** A palette row: the command, and why it is disabled when it cannot run in this context. */
export interface PaletteCommand {
  readonly command: CommandDefinition<CommandContext>;
  readonly disabledReason?: string;
}

const registry = new Map<CommandId, Command>();

/**
 * Adds a command to the registry. Ids are unique by construction: a duplicate is a bug in
 * registration order, not a runtime condition to recover from.
 *
 * @throws Error `duplicate-command` when `command.id` is already registered.
 */
export function registerCommand(command: Command): void {
  if (registry.has(command.id)) {
    throw new Error(`duplicate-command: ${command.id}`);
  }
  registry.set(command.id, command);
}

/** Removes a command; a no-op when the id is not registered. */
export function unregisterCommand(id: CommandId): void {
  registry.delete(id);
}

/** Empties the registry. Intended for tests and for hot-reload re-registration. */
export function resetCommands(): void {
  registry.clear();
}

/** The registered command for `id`, or `undefined`. */
export function getCommand(id: CommandId): Command | undefined {
  return registry.get(id);
}

function stripHandler(command: Command): CommandDefinition<CommandContext> {
  const { run, unavailable, ...definition } = command;
  void run;
  void unavailable;
  return definition;
}

/**
 * The commands that need something of the connected host's machine (hosted edition spec §3.1): without
 * the capability they are not offered anywhere (palette, menu, keybinding), whatever their `when` says.
 * The host refuses the channels behind them as well; this keeps them out of sight.
 */
export const COMMAND_CAPABILITIES: Readonly<Partial<Record<CommandId, Capability>>> = {
  'app.checkForUpdates': 'updates',
  // Local and git workspaces, and folders on the machine.
  'workspace.create': 'files',
  'workspace.join': 'files',
  'workspace.share': 'files',
  'workspace.stopSharing': 'files',
  'workspace.linkProject': 'files',
  'workspace.importProjectFolder': 'files',
  'sync.revealTree': 'files',
  // Writes a file or folder picked in a native dialog.
  'workspace.exportProject': 'dialogs',
  'workspace.exportPostman': 'dialogs',
  'workspace.exportOpenCollection': 'dialogs',
  'explorer.exportDefinition': 'dialogs',
  'explorer.generateDocs': 'dialogs',
  'request.exportWsiReport': 'dialogs',
  'editor.saveAs': 'dialogs',
  'editor.loadFrom': 'dialogs',
  'request.addAttachment': 'dialogs',
  // A listener on the machine's network.
  'mock.start': 'listen',
  'mock.stop': 'listen',
  'workspace.newWindow': 'windows',
  'workspace.secretSources': 'secret-sources',
  'secrets.clearSourceCache': 'secret-sources',
};

/** Whether the connected host can do what `command` needs; see {@link COMMAND_CAPABILITIES}. */
function hostCanRun(command: Command): boolean {
  const capability = COMMAND_CAPABILITIES[command.id];
  return capability === undefined || hasCapability(capability);
}

function isAvailable(command: Command, context: CommandContext): boolean {
  return hostCanRun(command) && (command.when === undefined || command.when(context));
}

/**
 * Runs a command.
 *
 * @returns `true` when it ran, `false` when its `when` guard denied it in this context.
 * @throws Error `unknown-command` when `id` is not registered.
 */
export async function runCommand(id: CommandId, context: CommandContext, arg?: unknown): Promise<boolean> {
  const command = registry.get(id);
  if (command === undefined) {
    throw new Error(`unknown-command: ${id}`);
  }
  if (!isAvailable(command, context)) {
    return false;
  }
  await command.run(context, arg);
  return true;
}

/**
 * Every registered command the connected host can run, ungated by `when`, sorted by category then
 * label. What the application menu and the shortcuts table are built from: main cannot evaluate a
 * `when` guard, so menu items are all generated and the registry decides at click time (see
 * `shell/app-menu.ts`). A command whose capability is missing ({@link COMMAND_CAPABILITIES}) is left
 * out: no click could ever run it.
 */
export function listAllCommands(): readonly CommandDefinition<CommandContext>[] {
  return [...registry.values()]
    .filter(hostCanRun)
    .map((command) => stripHandler(command))
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}

/**
 * What the palette lists in `context`: every available command, and every unavailable one that says why
 * (its `unavailable` reason), disabled. Sorted like {@link listCommands}.
 */
export function listPaletteCommands(context: CommandContext): readonly PaletteCommand[] {
  return [...registry.values()]
    .flatMap((command): PaletteCommand[] => {
      // A menu's argument-taking twin of a palette command (see `CommandCatalogEntry.paletteHidden`).
      if (command.paletteHidden === true) return [];
      // Not "disabled, because": the host cannot do it at all, so it is not listed.
      if (!hostCanRun(command)) return [];
      if (isAvailable(command, context)) return [{ command: stripHandler(command) }];
      const disabledReason = command.unavailable?.(context);
      return disabledReason === undefined ? [] : [{ command: stripHandler(command), disabledReason }];
    })
    .sort(
      (a, b) => a.command.category.localeCompare(b.command.category) || a.command.label.localeCompare(b.command.label),
    );
}

/**
 * The commands available in `context`, sorted by category then label — the order the palette
 * and generated menus present. Handlers are stripped so consumers cannot run a command
 * without going through {@link runCommand}.
 */
export function listCommands(context: CommandContext): readonly CommandDefinition<CommandContext>[] {
  return [...registry.values()]
    .filter((command) => isAvailable(command, context))
    .map((command) => stripHandler(command))
    .sort((a, b) => a.category.localeCompare(b.category) || a.label.localeCompare(b.label));
}
