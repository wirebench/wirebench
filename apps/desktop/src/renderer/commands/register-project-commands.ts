import { checkForUpdates } from '../lib/update-status.js';
import { getActiveRequestPaneHandle } from '../editor/active-request-editor.js';
import { cycleEnvironment } from '../features/environments/env-switcher.js';
import { projectActions } from '../features/project/project-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';
import { useWorkspaceStore } from '../state/workspace.js';
import { useSecretsVisibilityStore } from '../state/secrets-visibility.js';
import { activeGrpcRequestId, activeRequestId, activeRestRequestId, ui } from './command-helpers.js';

/** Registers the Project, Definition, Environment, Secrets and application commands. */
export function registerProjectCommands(): void {
  // No shortcut, and no `when`: checking for updates is always available and never urgent.
  registerCommand({
    id: 'app.checkForUpdates',
    label: 'Check for Updates…',
    category: 'General',
    run: () => {
      void checkForUpdates();
    },
  });
  registerCommand({
    id: 'definition.import',
    label: 'Import…',
    category: 'Definition',
    shortcut: 'Mod+I',
    run: () => {
      ui().openImportDialog();
    },
  });
  // `Mod+S` saves the tab in front of you; saving every project moved up to `Mod+Alt+S`.
  registerCommand({
    id: 'item.save',
    label: 'Save',
    category: 'Project',
    shortcut: 'Mod+S',
    when: () =>
      activeRequestId() !== undefined || activeRestRequestId() !== undefined || activeGrpcRequestId() !== undefined,
    whenScope: 'project',
    run: () => {
      const grpcRequestId = activeGrpcRequestId();
      if (grpcRequestId !== undefined) {
        void useProjectStore.getState().saveGrpcRequest(grpcRequestId);
        return;
      }
      // A REST tab saves the same way, minus the flush: its fields commit on Enter or blur, so
      // there is no debounce holding the last keystroke.
      const restRequestId = activeRestRequestId();
      if (restRequestId !== undefined) {
        void useProjectStore.getState().saveRestRequest(restRequestId);
        return;
      }
      const requestId = activeRequestId();
      if (requestId === undefined) {
        return;
      }
      // Flush before saving, because this is the command every route ends at — including the
      // one that never touches the editor. On macOS the native menu owns ⌘S: the accelerator
      // fires File ▸ Save, which invokes this, so the pane's own Monaco binding (which does
      // flush) never runs. Without this, ⌘S writes the last *debounced* envelope and the 120 ms
      // debounce then re-stages what was on screen — the dot reappears and the keystroke looks
      // like it did nothing. Clicking the same menu item worked only because the debounce had
      // long since fired by the time the mouse got there.
      getActiveRequestPaneHandle()?.flush();
      void useProjectStore.getState().saveRequest(requestId);
    },
  });

  registerCommand({
    id: 'project.save',
    label: 'Save All',
    category: 'Project',
    shortcut: 'Mod+Alt+S',
    when: () => Object.keys(useProjectStore.getState().projects).length > 0,
    whenScope: 'project',
    run: () => {
      // Flush first: the envelope edit the user is mid-way through typing is still sitting on
      // the pane's debounce, and a save is the moment they asked for everything to be written.
      // Autosave used to cover this by firing again once the debounce landed; with saving
      // manual, skipping it writes the model without the very edit that prompted the save.
      getActiveRequestPaneHandle()?.flush();
      void projectActions.save();
    },
  });

  registerCommand({
    id: 'env.switch',
    label: 'Switch Environment…',
    category: 'Environment',
    when: () => useWorkspaceStore.getState().workspace !== null,
    whenScope: 'project',
    // With no argument this opens the status bar's dropdown, which is where the choice lives.
    // The palette can also pass an environment name or id to switch straight to it.
    run: (_context, arg) => {
      if (typeof arg === 'string') {
        const environments = useWorkspaceStore.getState().workspace?.environments ?? [];
        const match = environments.find((env) => env.id === arg || env.name === arg);
        if (match !== undefined) {
          void useWorkspaceStore.getState().setActiveEnvironment(match.id);
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
    when: () => (useWorkspaceStore.getState().workspace?.environments.length ?? 0) > 0,
    whenScope: 'project.environments',
    run: () => {
      void cycleEnvironment(1);
    },
  });

  // No default shortcut: revealing credentials on screen should take a deliberate act, not a
  // key one finger-slip away.
  registerCommand({
    id: 'secrets.toggleShowSecrets',
    label: 'Toggle Show Secrets in HTTP Log',
    category: 'Secrets',
    run: () => {
      void useSecretsVisibilityStore.getState().toggle();
    },
  });
}
