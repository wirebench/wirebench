import { cycleEnvironment } from '../features/environments/env-switcher.js';
import { explorerActions } from '../features/explorer/explorer-actions.js';
import { projectActions } from '../features/welcome/project-actions.js';
import { registerCommand, resetCommands } from '../lib/commands.js';
import { useEditorsStore } from '../state/editors.js';
import { useExchangesStore } from '../state/exchanges.js';
import { useProjectStore } from '../state/project.js';
import { useUiStore } from '../state/ui.js';

/** The request draft behind the active editor tab, or `undefined` when none is a request tab. */
function activeRequestId(): string | undefined {
  const { tabs, activeId } = useEditorsStore.getState();
  return tabs.find((tab) => tab.id === activeId && tab.kind === 'request')?.requestId;
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
    label: 'New Project…',
    category: 'Project',
    shortcut: 'Mod+Shift+N',
    run: () => {
      void projectActions.newProject();
    },
  });
  registerCommand({
    id: 'project.open',
    label: 'Open Project…',
    category: 'Project',
    shortcut: 'Mod+O',
    run: () => {
      void projectActions.openProject();
    },
  });
  registerCommand({
    id: 'project.save',
    label: 'Save Project',
    category: 'Project',
    shortcut: 'Mod+S',
    when: () => useProjectStore.getState().project !== null,
    run: () => {
      void projectActions.save();
    },
  });
  registerCommand({
    id: 'project.close',
    label: 'Close Project',
    category: 'Project',
    when: () => useProjectStore.getState().project !== null,
    run: () => {
      void projectActions.close();
    },
  });

  registerCommand({
    id: 'env.switch',
    label: 'Switch Environment…',
    category: 'Environment',
    when: () => useProjectStore.getState().project !== null,
    // With no argument this opens the status bar's dropdown, which is where the choice lives.
    // The palette can also pass an environment name or id to switch straight to it.
    run: (_context, arg) => {
      if (typeof arg === 'string') {
        const { environments } = useProjectStore.getState();
        const match = environments.find((env) => env.id === arg || env.name === arg);
        if (match !== undefined) {
          void useProjectStore.getState().setActiveEnvironment(match.id);
          return;
        }
      }
      ui().setEnvSwitcherOpen(true);
    },
  });
  registerCommand({
    id: 'env.next',
    label: 'Next Environment',
    category: 'Environment',
    shortcut: 'Mod+Alt+E',
    when: () => useProjectStore.getState().environments.length > 0,
    run: () => {
      void cycleEnvironment(1);
    },
  });

  registerCommand({
    id: 'request.send',
    label: 'Send Request',
    category: 'Request',
    shortcut: 'Mod+Enter',
    when: () => activeRequestId() !== undefined,
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().send(requestId);
      }
    },
  });
  registerCommand({
    id: 'request.cancel',
    label: 'Cancel Request',
    category: 'Request',
    shortcut: 'Escape',
    // Escape must stay available to dialogs, menus, and the palette, so this command exists
    // only while the active request is actually in flight.
    when: () => {
      const requestId = activeRequestId();
      return requestId !== undefined && useExchangesStore.getState().byRequest[requestId]?.status === 'sending';
    },
    run: () => {
      const requestId = activeRequestId();
      if (requestId !== undefined) {
        void useExchangesStore.getState().cancel(requestId);
      }
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
      explorerActions.importAnother();
    },
  });
  registerCommand({
    id: 'explorer.removeInterface',
    label: 'Explorer: Remove Interface',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: (ctx) => {
      explorerActions.removeInterface(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.copyDefinitionUrl',
    label: 'Explorer: Copy Definition URL',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'interface',
    run: (ctx) => {
      explorerActions.copyDefinitionUrl(ctx.selection?.interfaceId);
    },
  });
  registerCommand({
    id: 'explorer.newRequest',
    label: 'Explorer: New Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    run: (ctx) => {
      explorerActions.newRequest(ctx.selection?.interfaceId, ctx.selection?.bindingName, ctx.selection?.operationName);
    },
  });
  registerCommand({
    id: 'explorer.copySoapAction',
    label: 'Explorer: Copy SOAPAction',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'operation',
    run: (ctx) => {
      explorerActions.copySoapAction(ctx.selection?.soapAction);
    },
  });
  registerCommand({
    id: 'explorer.openRequest',
    label: 'Explorer: Open Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.openRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.cloneRequest',
    label: 'Explorer: Clone Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.cloneRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.renameRequest',
    label: 'Explorer: Rename Request…',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.renameRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.deleteRequest',
    label: 'Explorer: Delete Request',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'request',
    run: (ctx) => {
      explorerActions.deleteRequest(ctx.selection?.requestId);
    },
  });
  registerCommand({
    id: 'explorer.copyEndpointAddress',
    label: 'Explorer: Copy Endpoint Address',
    category: 'Explorer',
    when: (ctx) => ctx.selection?.kind === 'endpoint',
    run: (ctx) => {
      explorerActions.copyEndpointAddress(ctx.selection?.address);
    },
  });
}
