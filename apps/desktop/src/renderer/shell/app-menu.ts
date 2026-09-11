/**
 * The renderer half of the native application menu. The command registry lives here, so this
 * is where the menu's contents come from: a manifest is pushed to main through
 * `app.registerMenu`, and main sends `command.invoke` back when an item is clicked.
 *
 * Menu items are generated ungated — main cannot evaluate a `when` guard — so a command whose
 * context does not allow it says so with a toast instead of running.
 */

import type { CommandInvokeEvent, MenuCommandWire } from '../../shared/wire-types.js';
import { showToast } from '../components/toast.js';
import type { CommandContext } from '../lib/commands.js';
import { getCommand, listAllCommands, runCommand } from '../lib/commands.js';
import { effectiveShortcut, toAccelerator } from '../lib/keybindings.js';
import { ipc } from '../state/ipc-client.js';

/** Every registered command as the application menu needs it. */
export function menuManifest(): readonly MenuCommandWire[] {
  return listAllCommands().map((command) => {
    const chord = effectiveShortcut(command);
    const accelerator = chord === undefined ? undefined : toAccelerator(chord);
    return {
      id: command.id,
      label: command.label,
      category: command.category,
      ...(accelerator !== undefined ? { accelerator } : {}),
    };
  });
}

/** Pushes the current manifest to main. Call after registration and after any keymap change. */
export async function syncAppMenu(): Promise<void> {
  await ipc().app.registerMenu({ items: [...menuManifest()] });
}

/**
 * Subscribes to `command.invoke`. `getContext` is a getter rather than a value because the
 * command context changes with every selection and panel toggle, and the subscription outlives
 * all of them.
 *
 * @returns the unsubscribe function.
 */
export function subscribeToMenuCommands(getContext: () => CommandContext): () => void {
  // `defineEvent` types every event's `name` as `string`, so the derived event map cannot narrow
  // a payload by channel; the cast below is the same one the state mirrors use.
  return window.wirebench.on('command.invoke', ((payload: CommandInvokeEvent) => {
    const id = payload.id as Parameters<typeof getCommand>[0];
    const command = getCommand(id);
    if (command === undefined) {
      return;
    }
    void runCommand(id, getContext()).then((ran) => {
      if (!ran) {
        showToast(`${command.label} is not available right now`);
      }
    });
  }) as (payload: unknown) => void);
}
