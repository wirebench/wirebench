import { catalogEntry } from '@shared/command-catalog.js';
import { editHost, openTerminalFor } from '../features/ssh/connect.js';
import { activeFilesTab, fileActions } from '../features/ssh/files/file-actions.js';
import { openFiles } from '../features/ssh/files/open-files.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import { registerCommand } from '../lib/commands.js';
import type { PaletteMode } from '../shell/command-palette.js';
import { useUiStore } from '../state/ui.js';

/** The `sftp.*` commands act on the Files tab in front. */
function onFilesTab(): boolean {
  return activeFilesTab() !== undefined;
}

/** The dialog lives in the Hosts view, so a command that opens it first makes that view visible. */
function revealHosts(): void {
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
}

/**
 * Registers the `ssh.*` commands of the Hosts area (the host / group dialog, and a host's terminal and Files
 * tab) and the `sftp.*` commands of the Files tab in front.
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
      editHost(arg);
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
  registerCommand({
    ...catalogEntry('ssh.openFiles'),
    run: (_context, arg) => {
      // From the palette there is no host to name yet, so it asks which one.
      if (typeof arg === 'string') openFiles(arg);
      else openPalette('files-hosts');
    },
  });
  registerCommand({
    ...catalogEntry('sftp.refresh'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const tabId = activeFilesTab();
      if (tabId !== undefined) fileActions.refresh(tabId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.newFolder'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const tabId = activeFilesTab();
      if (tabId !== undefined) fileActions.newFolder(tabId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.rename'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const tabId = activeFilesTab();
      if (tabId !== undefined) fileActions.rename(tabId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.delete'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const tabId = activeFilesTab();
      if (tabId !== undefined) fileActions.remove(tabId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.permissions'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const tabId = activeFilesTab();
      if (tabId !== undefined) fileActions.permissions(tabId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.toggleHidden'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      fileActions.toggleHidden();
    },
  });
  registerCommand({
    ...catalogEntry('sftp.focusPathBar'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const tabId = activeFilesTab();
      if (tabId !== undefined) fileActions.focusPathBar(tabId);
    },
  });
}
