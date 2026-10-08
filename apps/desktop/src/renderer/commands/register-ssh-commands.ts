import { catalogEntry } from '@shared/command-catalog.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import { registerCommand } from '../lib/commands.js';

/** Registers the `ssh.*` commands of the Hosts area: they open the host / group dialog. */
export function registerSshCommands(): void {
  registerCommand({
    ...catalogEntry('ssh.newHost'),
    run: () => {
      useHostsStore.getState().openDialog({ mode: 'new-host' });
    },
  });
  registerCommand({
    ...catalogEntry('ssh.newGroup'),
    run: () => {
      useHostsStore.getState().openDialog({ mode: 'new-group' });
    },
  });
  registerCommand({
    ...catalogEntry('ssh.editHost'),
    run: (_context, arg) => {
      if (typeof arg === 'string') useHostsStore.getState().openDialog({ mode: 'edit-host', id: arg });
    },
  });
}
