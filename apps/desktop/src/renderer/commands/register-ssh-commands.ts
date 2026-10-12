import { catalogEntry } from '@shared/command-catalog.js';
import { editHost, openInNewTab, openTerminalFor } from '../features/ssh/connect.js';
import { activeFilesPane, fileActions } from '../features/ssh/files/file-actions.js';
import { openFiles } from '../features/ssh/files/open-files.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import {
  activeTerminal,
  closePane,
  focusedPaneOf,
  moveFocus,
  requestSplit,
} from '../features/ssh/panes/pane-actions.js';
import { registerCommand } from '../lib/commands.js';
import type { PaletteMode } from '../shell/command-palette.js';
import { useUiStore } from '../state/ui.js';

/** The `sftp.*` commands act on the pane last used in the Files tab in front. */
function onFilesTab(): boolean {
  return activeFilesPane() !== undefined;
}

/** The pane commands act on the terminal tab in front. */
function onTerminalTab(): boolean {
  return activeTerminal() !== undefined;
}

/** The dialog lives in the Hosts view, so a command that opens it first makes that view visible. */
function revealHosts(): void {
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
}

/**
 * Registers the `ssh.*` commands of the Hosts area (the host / group dialog, a host's terminal and Files tab,
 * and the panes of the terminal tab in front) and the `sftp.*` commands of the Files tab in front.
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
    ...catalogEntry('ssh.openInNewTab'),
    run: (_context, arg) => {
      // From the palette there is no host to name yet, so it asks which one.
      if (typeof arg === 'string') openInNewTab(arg);
      else openPalette('new-tab-hosts');
    },
  });
  for (const [id, dir] of [
    ['ssh.splitRight', 'row'],
    ['ssh.splitDown', 'column'],
  ] as const) {
    registerCommand({
      ...catalogEntry(id),
      when: onTerminalTab,
      whenScope: 'editor.terminal',
      run: () => {
        const active = activeTerminal();
        if (active !== undefined) requestSplit(active.tabId, dir);
      },
    });
  }
  for (const [id, direction] of [
    ['ssh.focusPaneLeft', 'left'],
    ['ssh.focusPaneRight', 'right'],
    ['ssh.focusPaneUp', 'up'],
    ['ssh.focusPaneDown', 'down'],
  ] as const) {
    registerCommand({
      ...catalogEntry(id),
      when: onTerminalTab,
      whenScope: 'editor.terminal',
      run: () => {
        moveFocus(direction);
      },
    });
  }
  registerCommand({
    ...catalogEntry('ssh.closePane'),
    when: onTerminalTab,
    whenScope: 'editor.terminal',
    run: () => {
      const active = activeTerminal();
      const paneId = active === undefined ? undefined : focusedPaneOf(active.tabId, active.panes);
      if (active !== undefined && paneId !== undefined) closePane(active.tabId, paneId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.refresh'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.refresh(paneId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.newFolder'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.newFolder(paneId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.rename'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.rename(paneId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.delete'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.remove(paneId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.permissions'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.permissions(paneId);
    },
  });
  registerCommand({
    ...catalogEntry('sftp.copyToOtherPane'),
    when: onFilesTab,
    whenScope: 'editor.files',
    run: () => {
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.copyToOtherPane(paneId);
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
      const paneId = activeFilesPane();
      if (paneId !== undefined) fileActions.focusPathBar(paneId);
    },
  });
}
