import { showToast } from '../../components/toast.js';
import { openEnvironmentTab } from '../environments/environment-actions.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useUiStore } from '../../state/ui.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { startRenamingProject } from './explorer-api.js';

/**
 * The explorer's project-root actions — the right-click menu on a project, and the
 * `workspace.*` palette commands that act on the selected project. Both run these, so the menu
 * and the palette can never drift.
 */
export const projectRowActions = {
  /** Selects a project so the details panel, the palette's `selection.project` commands and
   * the import dialog's target all follow the row the user just acted on. */
  select(projectId: string): void {
    useUiStore.getState().setSelection({ kind: 'project', id: projectId });
  },

  /** Opens the Import WSDL dialog with this project preselected as the target. */
  importInto(projectId: string): void {
    projectRowActions.select(projectId);
    useUiStore.getState().openImportDialog();
  },

  /**
   * Opens a **linked** project's own environments editor. A linked project keeps its per-project
   * environments (they win over the workspace's on a shared slug), so the tab opens on the one
   * linked by slug to the workspace's active environment, else the project's first. A project
   * with no environments of its own gets one, named after the active workspace environment so
   * the slugs line up, because there is otherwise nothing to open.
   */
  async projectEnvironments(projectId: string): Promise<void> {
    const store = useProjectStore.getState();
    const environments = store.projects[projectId]?.environments ?? [];
    const workspace = useWorkspaceStore.getState().workspace;
    const active = workspace?.environments.find((candidate) => candidate.id === workspace.activeEnvironmentId);
    const match = environments.find((candidate) => candidate.slug === active?.slug) ?? environments[0];
    if (match !== undefined) {
      openEnvironmentTab({ kind: 'environment', id: match.id });
      return;
    }
    const created = await store.addEnvironment(projectId, active?.name ?? 'New environment');
    openEnvironmentTab({ kind: 'environment', id: created });
  },

  /** Enters inline rename mode on the project's row. */
  rename(projectId: string): void {
    startRenamingProject(projectId);
  },

  /** Commits an inline rename. An unchanged or empty name is left alone. */
  commitRename(projectId: string, name: string): void {
    const trimmed = name.trim();
    const current = useProjectStore.getState().projects[projectId]?.name;
    if (trimmed.length === 0 || trimmed === current) {
      return;
    }
    void useProjectStore
      .getState()
      .renameProject(projectId, trimmed)
      .catch((error: unknown) => {
        showToast(error instanceof Error ? error.message : 'Could not rename the project');
      });
  },

  /**
   * Shows the project's settings: its properties, in the Details panel. That is where a
   * project's own settings are edited today — there is no separate editor tab for them.
   */
  settings(projectId: string): void {
    projectRowActions.select(projectId);
    useUiStore.getState().showDetails('selection');
  },

  /** Shows the project folder in the OS file manager (main resolves the path from the id). */
  reveal(projectId: string): void {
    void workspaceActions.revealProject(projectId);
  },

  /** Writes a copy of the project to a folder the user picks in main's own dialog. */
  export(projectId: string): void {
    void workspaceActions.exportProject(projectId);
  },

  /** Opens the remove-from-workspace confirmation; nothing happens until it is answered. */
  remove(projectId: string): void {
    useUiStore.getState().requestRemoveProject(projectId);
  },

  /** Re-points a missing project at a folder the user picks in main's own dialog. */
  locate(projectId: string): void {
    void workspaceActions.locateProject(projectId);
  },
};
