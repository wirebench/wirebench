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
  /** Creates a workspace by name and opens it. */
  async create(name: string): Promise<void> {
    try {
      await useWorkspaceStore.getState().create(name);
    } catch (error) {
      report(error, 'Could not create the workspace');
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
