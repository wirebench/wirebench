import type { CommandId } from '@shared/commands.js';
import { registerCommand } from '../lib/commands.js';
import { cycleTheme } from '../lib/theme-actions.js';
import type { RequestViewType, ResponseViewType } from '../state/editors.js';
import { useEditorsStore } from '../state/editors.js';
import { activeRequestId, hasActiveRequest, ui } from './command-helpers.js';

/** The request pane's four views, as `view.request*` commands. */
const REQUEST_VIEWS: readonly (readonly [id: CommandId, label: string, view: RequestViewType])[] = [
  ['view.requestXml', 'Request: XML View', 'xml'],
  ['view.requestForm', 'Request: Form View', 'form'],
  ['view.requestOutline', 'Request: Outline View', 'outline'],
  ['view.requestRaw', 'Request: Raw View', 'raw'],
];

/** The response pane's four selectable views (the Fault tab is revealed, never chosen). */
const RESPONSE_VIEWS: readonly (readonly [id: CommandId, label: string, view: ResponseViewType])[] = [
  ['view.responseXml', 'Response: XML View', 'xml'],
  ['view.responseOutline', 'Response: Outline View', 'outline'],
  ['view.responseRaw', 'Response: Raw View', 'raw'],
  ['view.responseQuery', 'Response: Query View', 'query'],
];

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
    id: 'view.toggleCode',
    label: 'Toggle Code Panel',
    category: 'View',
    shortcut: 'Mod+Alt+B',
    run: () => {
      ui().toggleCode();
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
    id: 'view.showEnvironments',
    label: 'Show Environments',
    category: 'View',
    run: () => {
      ui().showSidebarView('environments');
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
      ui().openPreferences();
    },
  });
  registerCommand({
    id: 'preferences.open',
    label: 'Open Preferences',
    category: 'General',
    run: () => {
      ui().openPreferences();
    },
  });
  registerCommand({
    id: 'view.toggleTheme',
    label: 'Cycle Theme (Dark, Light, System)',
    category: 'View',
    run: () => {
      cycleTheme();
    },
  });

  // The pane view switchers. They ship without chords — the design's §5 table spends every
  // free one — but they are commands so the palette, the menu and a user rebind can reach them.
  for (const [id, label, view] of REQUEST_VIEWS) {
    registerCommand({
      id,
      label,
      category: 'View',
      when: hasActiveRequest,
      whenScope: 'editor.request',
      run: () => {
        const requestId = activeRequestId();
        if (requestId !== undefined) {
          useEditorsStore.getState().setRequestView(requestId, view);
        }
      },
    });
  }
  for (const [id, label, view] of RESPONSE_VIEWS) {
    registerCommand({
      id,
      label,
      category: 'View',
      when: hasActiveRequest,
      whenScope: 'editor.request',
      run: () => {
        const requestId = activeRequestId();
        if (requestId !== undefined) {
          useEditorsStore.getState().setResponseView(requestId, view);
        }
      },
    });
  }
}
