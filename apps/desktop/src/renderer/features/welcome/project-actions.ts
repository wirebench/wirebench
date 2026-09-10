import { showToast } from '../../components/toast.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';

/** The last `/`- or `\`-separated segment of a path — the folder's own name. */
export function basenameOf(path: string): string {
  const segments = path.split(/[\\/]/).filter((segment) => segment.length > 0);
  return segments.at(-1) ?? path;
}

async function pickFolder(title: string): Promise<string | undefined> {
  const result = await ipc().dialogs.openFolder({ title });
  return result.ok ? result.value.path : undefined;
}

/**
 * The project lifecycle actions, shared by the Welcome screen, the command palette and the
 * keyboard shortcuts, so those three can never drift. Each one reports its own failure as a
 * toast: none of them has a caller that could do anything better with an error.
 */
export const projectActions = {
  /** Picks a folder, then hands off to the New Project dialog for the name. */
  async newProject(): Promise<void> {
    const dir = await pickFolder('New Wirebench project');
    if (dir !== undefined) {
      useUiStore.getState().promptNewProject(dir);
    }
  },

  /** Creates the project the New Project dialog collected. */
  async create(dir: string, name: string): Promise<void> {
    try {
      await useProjectStore.getState().createProject(dir, name);
      useUiStore.getState().promptNewProject(undefined);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not create the project');
    }
  },

  /** Picks a folder and opens the project in it. */
  async openProject(): Promise<void> {
    const dir = await pickFolder('Open Wirebench project');
    if (dir !== undefined) {
      await projectActions.openAt(dir);
    }
  },

  /** Opens the project in `dir` (also the Recent list's click handler). */
  async openAt(dir: string): Promise<void> {
    try {
      await useProjectStore.getState().openProject(dir);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not open the project');
    }
  },

  /** Saves immediately, bypassing the autosave debounce. */
  async save(): Promise<void> {
    if (useProjectStore.getState().project === null) {
      return;
    }
    try {
      await useProjectStore.getState().save();
      showToast('Saved');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the project');
    }
  },

  /** Saves and closes the open project, returning the app to the Welcome screen. */
  async close(): Promise<void> {
    await useProjectStore.getState().closeProject();
  },

  /** Discards the renderer's mirror and re-reads the folder after an external change. */
  async reload(): Promise<void> {
    try {
      await useProjectStore.getState().reloadProject();
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not reload the project');
    }
  },
};
