import { cycleEnvironment } from '../features/environments/env-switcher.js';
import { projectActions } from '../features/welcome/project-actions.js';
import { registerCommand } from '../lib/commands.js';
import { useProjectStore } from '../state/project.js';
import { useSecretsVisibilityStore } from '../state/secrets-visibility.js';
import { ui } from './command-helpers.js';

/** Registers the Project, Definition, Environment and Secrets commands. */
export function registerProjectCommands(): void {
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
    whenScope: 'project',
    run: () => {
      void projectActions.save();
    },
  });
  registerCommand({
    id: 'project.close',
    label: 'Close Project',
    category: 'Project',
    when: () => useProjectStore.getState().project !== null,
    whenScope: 'project',
    run: () => {
      void projectActions.close();
    },
  });

  registerCommand({
    id: 'env.switch',
    label: 'Switch Environment…',
    category: 'Environment',
    when: () => useProjectStore.getState().project !== null,
    whenScope: 'project',
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
