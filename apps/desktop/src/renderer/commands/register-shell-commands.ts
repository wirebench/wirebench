import { showToast } from '../components/toast.js';
import { registerCommand, resetCommands } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';
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
    // The URL picker itself is Task 14's dialog; this command only wires an already-known
    // URL (passed as `arg`) into the project store. With no `arg`, there is nothing to
    // import yet, so it falls back to the same stub toast as before.
    run: async (_context, arg) => {
      if (typeof arg === 'string' && arg.length > 0) {
        await useProjectStore.getState().importDefinition({ kind: 'url', url: arg });
        return;
      }
      notImplemented('Import WSDL', 14);
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
}
