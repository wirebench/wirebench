import { resetCommands } from '../lib/commands.js';
import { registerEditorCommands } from './register-editor-commands.js';
import { registerExplorerCommands } from './register-explorer-commands.js';
import { registerProjectCommands } from './register-project-commands.js';
import { registerRequestCommands } from './register-request-commands.js';
import { registerViewCommands } from './register-view-commands.js';

/**
 * Registers every shell command. Called once at startup; safe to call again (it resets first)
 * so Vite's hot reload does not trip the duplicate-id guard.
 *
 * The registrations themselves are split by area — one module per command category group —
 * and this stays the single entry point, so nothing else has to know how they are grouped.
 *
 * @param openPalette - Opens the command palette in the given mode; owned by the shell, not the store.
 */
export function registerShellCommands(openPalette: (mode?: 'commands' | 'quick-open') => void): void {
  resetCommands();
  registerViewCommands(openPalette);
  registerProjectCommands();
  registerRequestCommands();
  registerEditorCommands();
  registerExplorerCommands();
}
