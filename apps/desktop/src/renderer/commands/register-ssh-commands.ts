import { catalogEntry } from '@shared/command-catalog.js';
import { openTerminalFor } from '../features/ssh/connect.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import { registerCommand } from '../lib/commands.js';
import type { PaletteMode } from '../shell/command-palette.js';
import { useUiStore } from '../state/ui.js';

/** The dialog lives in the Hosts view, so a command that opens it first makes that view visible. */
function revealHosts(): void {
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
}

/**
 * Registers the `ssh.*` commands of the Hosts area: the host / group dialog, and a host's terminal.
 *
 * @param openPalette - Opens the command palette in the given mode; owned by the shell.
 */
export function registerSshCommands(openPalette: (mode?: PaletteMode) => void): void {
  registerCommand({
    ...catalogEntry('ssh.newHost'),
    run: () => {
      revealHosts();
      useHostsStore.getState().openDialog({ mode: 'new-host' });
    },
  });
  registerCommand({
    ...catalogEntry('ssh.newGroup'),
    run: () => {
      revealHosts();
      useHostsStore.getState().openDialog({ mode: 'new-group' });
    },
  });
  registerCommand({
    ...catalogEntry('ssh.editHost'),
    run: (_context, arg) => {
      if (typeof arg !== 'string') return;
      revealHosts();
      useHostsStore.getState().openDialog({ mode: 'edit-host', id: arg });
    },
  });
  registerCommand({
    ...catalogEntry('ssh.importConfig'),
    run: () => {
      revealHosts();
      useHostsStore.getState().setImportOpen(true);
    },
  });
  registerCommand({
    ...catalogEntry('ssh.connect'),
    run: (_context, arg) => {
      // From the palette there is no host to name yet, so it asks which one.
      if (typeof arg === 'string') openTerminalFor(arg);
      else openPalette('hosts');
    },
  });
  registerCommand({
    ...catalogEntry('ssh.connectPalette'),
    run: () => {
      openPalette('hosts');
    },
  });
}
