import type { CommandDefinition, CommandId } from '@shared/commands.js';
import type { UiSnapshot } from '../state/ui-state.js';
import type { Selection } from '../state/ui.js';
import type { Platform } from './platform.js';

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

function isAvailable(command: Command, context: CommandContext): boolean {
  return command.when === undefined || command.when(context);
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
 * Every registered command, ungated, sorted by category then label. What the application menu
 * is built from: main cannot evaluate a `when` guard, so menu items are all generated and the
 * registry decides at click time (see `shell/app-menu.ts`).
 */
export function listAllCommands(): readonly CommandDefinition<CommandContext>[] {
  return [...registry.values()]
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
