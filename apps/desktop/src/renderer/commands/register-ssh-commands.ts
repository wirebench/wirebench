import { catalogEntry } from '@shared/command-catalog.js';
import { editHost, openInNewTab, openTerminalFor } from '../features/ssh/connect.js';
import { activeFilesPane, fileActions } from '../features/ssh/files/file-actions.js';
import { openFiles } from '../features/ssh/files/open-files.js';
import {
  showForwarding,
  startForward,
  stopAllForwards,
  stopForward,
} from '../features/ssh/forwarding/forward-actions.js';
import { useHostsStore } from '../features/ssh/hosts-store.js';
import {
  activeTerminal,
  closePane,
  focusedPaneOf,
  moveFocus,
  requestSplit,
} from '../features/ssh/panes/pane-actions.js';
import { toggleBroadcast } from '../features/ssh/panes/broadcast.js';
import { useLayoutsStore } from '../features/ssh/panes/layouts-store.js';
import { leaves } from '../features/ssh/panes/pane-tree.js';
import { startRun } from '../features/ssh/snippets/run.js';
import { openSnippetPicker, showSnippets, snippetById } from '../features/ssh/snippets/snippet-actions.js';
import { useSnippetsStore } from '../features/ssh/snippets/snippets-store.js';
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

/** A forward named as `hostId/ruleId`, as menus pass it; anything else asks in the palette. */
function forwardArg(arg: unknown): { hostId: string; ruleId: string } | undefined {
  if (typeof arg !== 'string') return undefined;
  const [hostId, ruleId, ...rest] = arg.split('/');
  return hostId && ruleId && rest.length === 0 ? { hostId, ruleId } : undefined;
}

/** The dialog lives in the Hosts view, so a command that opens it first makes that view visible. */
function revealHosts(): void {
  const { sidebar, showSidebarView } = useUiStore.getState();
  if (!sidebar.visible || sidebar.view !== 'ssh') showSidebarView('ssh');
}

/**
 * Registers the `ssh.*` commands of the Hosts area (the host / group dialog, a host's terminal and Files tab,
 * the panes of the terminal tab in front, port forwards and snippets) and the `sftp.*` commands of the Files tab in front.
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
    ...catalogEntry('ssh.importKnownHosts'),
    run: () => {
      // The dialog lives in the Known hosts view, which shows on the Hosts home.
      revealHosts();
      const hosts = useHostsStore.getState();
      hosts.setHomeView('known-hosts');
      hosts.setKnownHostsImportOpen(true);
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
  registerCommand({
    ...catalogEntry('ssh.openLayout'),
    run: () => {
      openPalette('layouts');
    },
  });
  registerCommand({
    ...catalogEntry('ssh.saveLayout'),
    when: onTerminalTab,
    whenScope: 'editor.terminal',
    run: () => {
      const active = activeTerminal();
      if (active !== undefined) useLayoutsStore.getState().setSavingTabId(active.tabId);
    },
  });
  registerCommand({
    ...catalogEntry('view.showForwarding'),
    run: () => {
      showForwarding();
    },
  });
  // From a menu the argument names the forward as `hostId/ruleId`; from the palette it asks which one.
  registerCommand({
    ...catalogEntry('ssh.startForward'),
    run: (_context, arg) => {
      const named = forwardArg(arg);
      if (named === undefined) openPalette('start-forward');
      else void startForward(named.hostId, named.ruleId);
    },
  });
  registerCommand({
    ...catalogEntry('ssh.stopForward'),
    run: (_context, arg) => {
      const named = forwardArg(arg);
      if (named === undefined) openPalette('stop-forward');
      else void stopForward(named.hostId, named.ruleId);
    },
  });
  registerCommand({
    ...catalogEntry('ssh.stopAllForwards'),
    run: () => {
      void stopAllForwards();
    },
  });
  registerCommand({
    ...catalogEntry('view.showSnippets'),
    run: () => {
      showSnippets();
    },
  });
  registerCommand({
    ...catalogEntry('ssh.newSnippet'),
    run: () => {
      showSnippets();
      useSnippetsStore.getState().openEditor({ mode: 'new' });
    },
  });
  registerCommand({
    ...catalogEntry('ssh.editSnippet'),
    run: (_context, arg) => {
      showSnippets();
      if (typeof arg === 'string') useSnippetsStore.getState().openEditor({ mode: 'edit', id: arg });
    },
  });
  // Named, it runs into the terminal in front (or asks first, as a row's Run does); else the palette asks which.
  registerCommand({
    ...catalogEntry('ssh.runSnippet'),
    run: async (_context, arg) => {
      if (typeof arg !== 'string') {
        openPalette('snippets');
        return;
      }
      const item = await snippetById(arg);
      if (item !== undefined) startRun(item);
    },
  });
  registerCommand({
    ...catalogEntry('ssh.runSnippetPalette'),
    run: () => {
      openPalette('snippets');
    },
  });
  registerCommand({
    ...catalogEntry('ssh.snippetPicker'),
    when: onTerminalTab,
    whenScope: 'editor.terminal',
    run: () => {
      openSnippetPicker();
    },
  });
  registerCommand({
    ...catalogEntry('ssh.toggleBroadcast'),
    when: onTerminalTab,
    whenScope: 'editor.terminal',
    run: () => {
      const active = activeTerminal();
      if (active !== undefined) {
        toggleBroadcast(
          active.tabId,
          leaves(active.panes).map((leaf) => leaf.paneId),
        );
      }
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
