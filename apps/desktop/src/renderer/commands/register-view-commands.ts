import { openPreferencesTab } from '../features/preferences/section-list.js';
import { registerCommand } from '../lib/commands.js';
import { usePreferencesStore } from '../state/preferences.js';
import { ui } from './command-helpers.js';

/**
 * Registers the General and View commands: the palette, the panel toggles, the activity-bar
 * views and the theme switch.
 *
 * @param openPalette - Opens the command palette in the given mode; owned by the shell.
 */
export function registerViewCommands(openPalette: (mode: 'commands' | 'quick-open') => void): void {
  registerCommand({
    id: 'palette.open',
    label: 'Show All Commands',
    category: 'General',
    shortcut: 'Mod+K',
    // The design gives the palette both ⌘K and ⌘⇧P; the second is an alias, so it is not
    // offered to the menu and cannot be rebound on its own.
    extraShortcuts: ['Mod+Shift+P'],
    run: () => {
      openPalette('commands');
    },
  });
  registerCommand({
    id: 'palette.quickOpen',
    label: 'Go to Operation or Request…',
    category: 'General',
    shortcut: 'Mod+P',
    run: () => {
      openPalette('quick-open');
    },
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
    id: 'view.showWss',
    label: 'Show WS-Security',
    category: 'View',
    run: () => {
      ui().showSidebarView('wss');
    },
  });
  registerCommand({
    id: 'view.showSettings',
    label: 'Show Settings',
    category: 'View',
    shortcut: 'Mod+Comma',
    run: () => {
      // The sidebar lists the sections; the editable forms live in the Preferences tab, so the
      // familiar ⌘, opens both rather than only revealing a table of contents.
      ui().showSidebarView('settings');
      openPreferencesTab();
    },
  });
  registerCommand({
    id: 'preferences.open',
    label: 'Open Preferences',
    category: 'General',
    run: () => {
      openPreferencesTab();
    },
  });
  registerCommand({
    id: 'view.toggleTheme',
    label: 'Toggle Light/Dark Theme',
    category: 'View',
    run: () => {
      // The persisted truth is `preferences.ui.theme`; the ui store mirrors it for rendering.
      const next = ui().theme === 'light' ? 'dark' : 'light';
      void usePreferencesStore.getState().update({ ui: { theme: next } });
    },
  });
}
