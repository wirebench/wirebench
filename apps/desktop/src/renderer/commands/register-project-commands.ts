import { checkForUpdates } from '../lib/update-status.js';
import { cycleEnvironment } from '../features/environments/env-switcher.js';
import { projectActions } from '../features/project/project-actions.js';
import { workspaceActions } from '../features/workspace/workspace-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';
import { useWorkspaceStore } from '../state/workspace.js';
import { useSecretsVisibilityStore } from '../state/secrets-visibility.js';
import { ui } from './command-helpers.js';

/** Registers the Workspace, Project, Definition, Environment, Secrets and application commands. */
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
    label: 'Import WSDL…',
    category: 'Definition',
    shortcut: 'Mod+I',
    run: () => {
      ui().openImportDialog();
    },
  });
  // `project.new` / `project.open` / `project.close` are gone: a project belongs to a
  // workspace, so creating one is a workspace command, and it asks for a name only.
  registerCommand({
    id: 'workspace.newProject',
    label: 'New Project…',
    category: 'Workspace',
    shortcut: 'Mod+Shift+N',
    when: () => useWorkspaceStore.getState().workspace !== null,
    whenScope: 'workspace',
    run: () => {
      workspaceActions.newProject();
    },
  });
  registerCommand({
    id: 'project.save',
    label: 'Save All',
    category: 'Project',
    shortcut: 'Mod+S',
    when: () => Object.keys(useProjectStore.getState().projects).length > 0,
    whenScope: 'project',
    run: () => {
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
