import { showToast } from '../../components/toast.js';
import { useProjectStore } from '../../state/project.js';

/**
 * The project actions shared by the command palette, the keyboard shortcuts and the
 * changed-on-disk banner, so those can never drift. Each one reports its own failure as a
 * toast: none of them has a caller that could do anything better with an error.
 *
 * Creating, opening and closing a project are *not* here: a project belongs to a workspace, so
 * those are `useWorkspaceStore` actions driven from the explorer.
 */
export const projectActions = {
  /** Saves every open project immediately, bypassing the autosave debounce. */
  async save(): Promise<void> {
    if (Object.keys(useProjectStore.getState().projects).length === 0) {
      return;
    }
    try {
      await useProjectStore.getState().save();
      showToast('Saved');
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not save the project');
    }
  },

  /** Discards the renderer's mirror of one project and re-reads its folder after an external change. */
  async reload(projectId: string): Promise<void> {
    try {
      await useProjectStore.getState().reloadProject(projectId);
    } catch (error) {
      showToast(error instanceof Error ? error.message : 'Could not reload the project');
    }
  },
};
