import { showToast } from '../../components/toast.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';

function report(error: unknown, fallback: string): void {
  showToast(error instanceof Error ? error.message : fallback);
}

/**
 * The workspace actions shared by the picker, the explorer toolbar, the command palette and
 * (later) the explorer's project context menu, so those can never drift. Each one reports its
 * own failure as a toast and resolves rather than rejecting: none of their callers could do
 * anything better with the error.
 */
export const workspaceActions = {
  /** Creates a workspace by name and opens it. `false` when main refused (already reported). */
  async create(name: string): Promise<boolean> {
    try {
      await useWorkspaceStore.getState().create(name);
      return true;
    } catch (error) {
      report(error, 'Could not create the workspace');
      return false;
    }
  },

  /** Opens a workspace from the picker's list. */
  async open(workspaceId: string): Promise<void> {
    try {
      await useWorkspaceStore.getState().open(workspaceId);
    } catch (error) {
      report(error, 'Could not open the workspace');
    }
  },

  /** Renames a workspace, open or not. `false` when main refused (already reported). */
  async rename(workspaceId: string, name: string): Promise<boolean> {
    try {
      await useWorkspaceStore.getState().rename(workspaceId, name);
      await useWorkspaceStore.getState().refresh();
      return true;
    } catch (error) {
      report(error, 'Could not rename the workspace');
      return false;
    }
  },

  /**
   * Moves a workspace to the trash. Deleting the open one leaves no workspace open, which is
   * the picker — main closes it and the `workspace.changed` event brings the renderer along.
   */
  async remove(workspaceId: string): Promise<void> {
    try {
      await useWorkspaceStore.getState().remove(workspaceId);
      // Its remembered tabs name entities that no longer exist anywhere.
      useUiStore.getState().setWorkspaceUi(workspaceId, undefined);
    } catch (error) {
      report(error, 'Could not delete the workspace');
    }
  },

  /** Adds a project folder the user picks to the workspace, leaving it where it is. */
  async linkProject(): Promise<void> {
    try {
      await useWorkspaceStore.getState().linkProject();
    } catch (error) {
      report(error, 'Could not link the project folder');
    }
  },

  /** Writes one project out to a folder the user picks. */
  async exportProject(projectId: string): Promise<void> {
    try {
      const dir = await useWorkspaceStore.getState().exportProject(projectId);
      if (dir !== null) {
        showToast(`Exported to ${dir}`);
      }
    } catch (error) {
      report(error, 'Could not export the project');
    }
  },

  /**
   * Removes a project from the workspace. `deleteFiles` moves an *internal* project's folder to
   * the OS trash; it is never passed for a linked project, whose folder is not ours to touch.
   */
  async removeProject(projectId: string, deleteFiles = false): Promise<void> {
    try {
      await useWorkspaceStore.getState().removeProject(projectId, deleteFiles);
    } catch (error) {
      report(error, 'Could not remove the project');
    }
  },

  /** Re-points a missing linked project at a folder the user picks in main's own dialog. */
  async locateProject(projectId: string): Promise<void> {
    try {
      await useWorkspaceStore.getState().locateProject(projectId);
    } catch (error) {
      report(error, 'Could not locate the project folder');
    }
  },

  /** Shows one project's folder in the OS file manager. */
  async revealProject(projectId: string): Promise<void> {
    try {
      await useWorkspaceStore.getState().revealProject(projectId);
    } catch (error) {
      report(error, 'Could not show the project folder');
    }
  },

  /** Shows a workspace's folder in the OS file manager (the way out for an unreadable one). */
  async reveal(workspaceId: string): Promise<void> {
    try {
      await useWorkspaceStore.getState().reveal(workspaceId);
    } catch (error) {
      report(error, 'Could not show the workspace folder');
    }
  },

  /**
   * Copies a project folder the user picks into the open workspace — or, from the picker, into
   * a new workspace named after the folder.
   */
  async importProjectFolder(): Promise<void> {
    try {
      await useWorkspaceStore.getState().importProjectFolder();
    } catch (error) {
      report(error, 'Could not import the project folder');
    }
  },

  /** {@link importProjectFolder} for one of the picker's suggested (previously opened) folders. */
  async importSuggestion(index: number): Promise<void> {
    try {
      await useWorkspaceStore.getState().importSuggestion(index);
    } catch (error) {
      report(error, 'Could not import the project folder');
    }
  },

  /** Opens the New Project dialog (name only). */
  newProject(): void {
    useUiStore.getState().setNewProjectDialogOpen(true);
  },

  /**
   * Creates a project by name in the open workspace and selects it in the explorer, so the
   * next Import WSDL lands in it rather than in a project of its own.
   *
   * @returns the new project's id, or `undefined` when it failed (already reported).
   */
  async addProject(name: string): Promise<string | undefined> {
    try {
      const projectId = await useWorkspaceStore.getState().addProject(name);
      useUiStore.getState().setSelection({ kind: 'project', id: projectId });
      return projectId;
    } catch (error) {
      report(error, 'Could not create the project');
      return undefined;
    }
  },
};
