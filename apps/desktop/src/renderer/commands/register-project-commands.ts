import { catalogEntry } from '@shared/command-catalog.js';
import { checkForUpdates } from '../lib/update-status.js';
import { getActiveRequestPaneHandle } from '../editor/active-request-editor.js';
import { cycleEnvironment } from '../features/environments/env-switcher.js';
import { setProjectEnvironment } from '../features/environments/environment-actions.js';
import { projectActions } from '../features/project/project-actions.js';
import { openSecretTokenDialog } from '../features/secrets/secret-token-actions.js';
import { registerCommand } from '../lib/commands.js';
import { showToast } from '../components/toast.js';
import { ipc } from '../state/ipc-client.js';
import { useProjectStore } from '../state/project.js';
import { switcherEnvironments } from '../state/environment-scope.js';
import { useWorkspaceStore } from '../state/workspace.js';
import { currentProjectId } from '../state/workspace-tabs.js';
import { useSecretsVisibilityStore } from '../state/secrets-visibility.js';
import {
  activeGrpcRequestId,
  activeMcpRequestId,
  activeRequestId,
  activeRestRequestId,
  activeWsRequestId,
  ui,
} from './command-helpers.js';

/** Registers the Project, Definition, Environment, Secrets and application commands. */
export function registerProjectCommands(): void {
  // No shortcut, and no `when`: checking for updates is always available and never urgent.
  registerCommand({
    ...catalogEntry('app.checkForUpdates'),
    run: () => {
      void checkForUpdates();
    },
  });
  registerCommand({
    ...catalogEntry('definition.import'),
    run: () => {
      ui().openImportDialog();
    },
  });
  // `Mod+S` saves the tab in front of you; saving every project moved up to `Mod+Alt+S`. Both are
  // manual saves, so both review the project for plain-text secrets before writing.
  registerCommand({
    ...catalogEntry('item.save'),
    when: () =>
      activeRequestId() !== undefined ||
      activeRestRequestId() !== undefined ||
      activeGrpcRequestId() !== undefined ||
      activeWsRequestId() !== undefined ||
      activeMcpRequestId() !== undefined,
    whenScope: 'project',
    run: () => {
      const mcpRequestId = activeMcpRequestId();
      if (mcpRequestId !== undefined) {
        void useProjectStore.getState().saveMcpRequest(mcpRequestId, { manual: true });
        return;
      }
      // A WebSocket tab writes its staged edits (saved messages included) the way a gRPC one does.
      const wsRequestId = activeWsRequestId();
      if (wsRequestId !== undefined) {
        void useProjectStore.getState().saveWsRequest(wsRequestId, { manual: true });
        return;
      }
      const grpcRequestId = activeGrpcRequestId();
      if (grpcRequestId !== undefined) {
        void useProjectStore.getState().saveGrpcRequest(grpcRequestId, { manual: true });
        return;
      }
      // A REST tab saves the same way, minus the flush: its fields commit on Enter or blur, so
      // there is no debounce holding the last keystroke.
      const restRequestId = activeRestRequestId();
      if (restRequestId !== undefined) {
        void useProjectStore.getState().saveRestRequest(restRequestId, { manual: true });
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
      void useProjectStore.getState().saveRequest(requestId, { manual: true });
    },
  });

  registerCommand({
    ...catalogEntry('project.save'),
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
    ...catalogEntry('env.switch'),
    // Needs a current project (#468): the switcher is disabled without one.
    when: () => useWorkspaceStore.getState().workspace !== null && currentProjectId() !== undefined,
    whenScope: 'project',
    // With no argument this opens the status bar's dropdown, which is where the choice lives.
    // The palette can also pass an environment name or id to switch straight to it.
    run: (_context, arg) => {
      // A name or id switches the current project (#468), among the environments that apply to it.
      const workspace = useWorkspaceStore.getState().workspace;
      const projectId = currentProjectId();
      if (typeof arg === 'string' && workspace !== null && projectId !== undefined) {
        const match = switcherEnvironments(workspace, projectId).find((env) => env.id === arg || env.name === arg);
        if (match !== undefined) {
          void setProjectEnvironment(projectId, match.id);
          return;
        }
      }
      ui().setEnvSwitcherOpen(true);
    },
  });
  registerCommand({
    ...catalogEntry('env.next'),
    // Available only when it can do something: a current project with an environment that applies to it.
    when: () => {
      const workspace = useWorkspaceStore.getState().workspace;
      const projectId = currentProjectId();
      return workspace !== null && projectId !== undefined && switcherEnvironments(workspace, projectId).length > 0;
    },
    whenScope: 'project.environments',
    run: () => {
      void cycleEnvironment(1);
    },
  });

  // No default shortcut: revealing credentials on screen should take a deliberate act, not a
  // key one finger-slip away. Revealing asks first; when they are already shown it hides them.
  registerCommand({
    ...catalogEntry('secrets.toggleShowSecrets'),
    run: () => {
      void useSecretsVisibilityStore.getState().requestToggle();
    },
  });

  // The one place a `${secret:name}` token's value is typed in directly (a save's review is the
  // other way in). No shortcut: it opens a dialog, and the palette finds it by name.
  registerCommand({
    ...catalogEntry('secrets.setTokenValue'),
    when: () => Object.keys(useProjectStore.getState().projects).length > 0,
    whenScope: 'project',
    run: () => {
      openSecretTokenDialog();
    },
  });

  // Values fetched from an external manager are cached for a few minutes; this forgets them, so the
  // next send asks the tool again (after a rotation, say). Needs no project: the cache is main's.
  registerCommand({
    ...catalogEntry('secrets.clearSourceCache'),
    run: async () => {
      const result = await ipc().secretSources.clearCache(undefined);
      showToast(result.ok ? 'Secret source cache cleared.' : result.error.message);
    },
  });
}
