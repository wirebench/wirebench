import { showToast } from '../components/toast.js';
import { registerCommand, resetCommands } from '../lib/commands.js';
import { useUiStore } from '../state/ui.js';

/** Stubs announce their own task number so the gap is visible in the UI, not just the backlog. */
function notImplemented(what: string, task: number): void {
  // A deliberate breadcrumb in the dev console until the real handler lands.
  console.info(`[wirebench] ${what}: not implemented yet (Task ${String(task)})`);
  showToast(`${what} — not implemented yet (Task ${String(task)})`);
}

/**
 * Registers every shell command. Called once at startup; safe to call again (it resets first)
 * so Vite's hot reload does not trip the duplicate-id guard.
 *
 * @param openPalette - Opens the command palette; owned by the shell, not the store.
 */
export function registerShellCommands(openPalette: () => void): void {
  resetCommands();
  const ui = () => useUiStore.getState();

  registerCommand({
    id: 'palette.open',
    label: 'Show All Commands',
    category: 'General',
    shortcut: 'Mod+K',
    run: openPalette,
  });

  registerCommand({
    id: 'view.toggleSidebar',
    label: 'Toggle Sidebar',
    category: 'View',
    shortcut: 'Mod+B',
    run: () => {
      ui().toggleSidebar();
    },
  });
  registerCommand({
    id: 'view.toggleConsole',
    label: 'Toggle Console',
    category: 'View',
    shortcut: 'Mod+J',
    run: () => {
      ui().toggleConsole();
    },
  });
  registerCommand({
    id: 'view.toggleDetails',
    label: 'Toggle Details Panel',
    category: 'View',
    shortcut: 'Mod+Alt+B',
    run: () => {
      ui().toggleDetails();
    },
  });

  registerCommand({
    id: 'view.showExplorer',
    label: 'Show Explorer',
    category: 'View',
    shortcut: 'Mod+Shift+E',
    run: () => {
      ui().showSidebarView('explorer');
    },
  });
  registerCommand({
    id: 'view.showSearch',
    label: 'Show Search',
    category: 'View',
    shortcut: 'Mod+Shift+S',
    run: () => {
      ui().showSidebarView('search');
    },
  });
  registerCommand({
    id: 'view.showHistory',
    label: 'Show History',
    category: 'View',
    shortcut: 'Mod+Shift+Y',
    run: () => {
      ui().showSidebarView('history');
    },
  });
  registerCommand({
    id: 'view.showSettings',
    label: 'Show Settings',
    category: 'View',
    shortcut: 'Mod+Comma',
    run: () => {
      ui().showSidebarView('settings');
    },
  });
  registerCommand({
    id: 'view.toggleTheme',
    label: 'Toggle Light/Dark Theme',
    category: 'View',
    run: () => {
      ui().toggleTheme();
    },
  });

  registerCommand({
    id: 'definition.import',
    label: 'Import WSDL…',
    category: 'Definition',
    shortcut: 'Mod+I',
    run: () => {
      ui().openImportDialog();
    },
  });
  registerCommand({
    id: 'project.new',
    label: 'New Project',
    category: 'Project',
    shortcut: 'Mod+Shift+N',
    run: () => {
      notImplemented('New project', 13);
    },
  });
  registerCommand({
    id: 'project.open',
    label: 'Open Project…',
    category: 'Project',
    shortcut: 'Mod+O',
    run: () => {
      notImplemented('Open project', 13);
    },
  });

  // Every explorer context-menu action is also a command, so the palette can run it against
  // whatever node is currently selected. The menu itself (context-menu.tsx) owns the actual
  // logic; these mirror the same `when` gates so the palette only lists what applies.
  registerCommand({
    id: 'explorer.importAnother',
    label: 'Explorer: Import Another WSDL…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: () => {
      ui().openImportDialog();
    },
  });
  registerCommand({
    id: 'explorer.removeInterface',
    label: 'Explorer: Remove Interface',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: () => {
      notImplemented('Remove interface from the palette', 14);
    },
  });
  registerCommand({
    id: 'explorer.copyDefinitionUrl',
    label: 'Explorer: Copy Definition URL',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: () => {
      notImplemented('Copy definition URL from the palette', 14);
    },
  });
  registerCommand({
    id: 'explorer.newRequest',
    label: 'Explorer: New Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    run: () => {
      notImplemented('New request from the palette', 15);
    },
  });
  registerCommand({
    id: 'explorer.copySoapAction',
    label: 'Explorer: Copy SOAPAction',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    run: () => {
      notImplemented('Copy SOAPAction from the palette', 14);
    },
  });
  registerCommand({
    id: 'explorer.openRequest',
    label: 'Explorer: Open Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: () => {
      notImplemented('Open request from the palette', 15);
    },
  });
  registerCommand({
    id: 'explorer.cloneRequest',
    label: 'Explorer: Clone Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: () => {
      notImplemented('Clone request from the palette', 15);
    },
  });
  registerCommand({
    id: 'explorer.renameRequest',
    label: 'Explorer: Rename Request…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: () => {
      notImplemented('Rename request from the palette', 15);
    },
  });
  registerCommand({
    id: 'explorer.deleteRequest',
    label: 'Explorer: Delete Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: () => {
      notImplemented('Delete request from the palette', 15);
    },
  });
  registerCommand({
    id: 'explorer.copyEndpointAddress',
    label: 'Explorer: Copy Endpoint Address',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'endpoint',
    run: () => {
      notImplemented('Copy endpoint address from the palette', 14);
    },
  });
}
