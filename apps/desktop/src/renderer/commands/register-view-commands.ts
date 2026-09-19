import type { CommandId } from '@shared/commands.js';
import { catalogEntry } from '@shared/command-catalog.js';
import { registerCommand } from '../lib/commands.js';
import { cycleTheme } from '../lib/theme-actions.js';
import type { RequestViewType, ResponseViewType } from '../state/editors.js';
import { useEditorsStore } from '../state/editors.js';
import { activeRequestId, hasActiveRequest, ui } from './command-helpers.js';

/** The request pane's four views, as `view.request*` commands. Labels live in the catalog. */
const REQUEST_VIEWS: readonly (readonly [id: CommandId, view: RequestViewType])[] = [
  ['view.requestXml', 'xml'],
  ['view.requestForm', 'form'],
  ['view.requestOutline', 'outline'],
  ['view.requestRaw', 'raw'],
];

/** The response pane's four selectable views (the Fault tab is revealed, never chosen). */
const RESPONSE_VIEWS: readonly (readonly [id: CommandId, view: ResponseViewType])[] = [
  ['view.responseXml', 'xml'],
  ['view.responseOutline', 'outline'],
  ['view.responseRaw', 'raw'],
  ['view.responseQuery', 'query'],
];

/**
 * Registers the General and View commands: the palette, the panel toggles, the activity-bar
 * views and the theme switch.
 *
 * @param openPalette - Opens the command palette in the given mode; owned by the shell.
 */
export function registerViewCommands(openPalette: (mode: 'commands' | 'quick-open') => void): void {
  registerCommand({
    ...catalogEntry('palette.open'),
    run: () => {
      openPalette('commands');
    },
  });
  registerCommand({
    ...catalogEntry('palette.quickOpen'),
    run: () => {
      openPalette('quick-open');
    },
  });

  registerCommand({
    ...catalogEntry('view.toggleSidebar'),
    run: () => {
      ui().toggleSidebar();
    },
  });
  registerCommand({
    ...catalogEntry('view.toggleConsole'),
    run: () => {
      ui().toggleConsole();
    },
  });
  registerCommand({
    ...catalogEntry('view.toggleCode'),
    run: () => {
      ui().toggleCode();
    },
  });

  registerCommand({
    ...catalogEntry('view.showExplorer'),
    run: () => {
      ui().showSidebarView('explorer');
    },
  });
  registerCommand({
    ...catalogEntry('view.showEnvironments'),
    run: () => {
      ui().showSidebarView('environments');
    },
  });
  registerCommand({
    ...catalogEntry('view.showSearch'),
    run: () => {
      ui().showSidebarView('search');
    },
  });
  registerCommand({
    ...catalogEntry('view.showHistory'),
    run: () => {
      ui().showSidebarView('history');
    },
  });
  registerCommand({
    ...catalogEntry('view.showWss'),
    run: () => {
      ui().showSidebarView('wss');
    },
  });
  registerCommand({
    ...catalogEntry('view.showSettings'),
    run: () => {
      ui().openPreferences();
    },
  });
  registerCommand({
    ...catalogEntry('preferences.open'),
    run: () => {
      ui().openPreferences();
    },
  });
  registerCommand({
    ...catalogEntry('view.toggleTheme'),
    run: () => {
      cycleTheme();
    },
  });

  // The pane view switchers. They ship without chords — the design's §5 table spends every
  // free one — but they are commands so the palette, the menu and a user rebind can reach them.
  for (const [id, view] of REQUEST_VIEWS) {
    registerCommand({
      ...catalogEntry(id),
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
  for (const [id, view] of RESPONSE_VIEWS) {
    registerCommand({
      ...catalogEntry(id),
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
