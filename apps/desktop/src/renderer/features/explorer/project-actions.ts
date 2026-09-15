import { showToast } from '../../components/toast.js';
import { openEnvironmentTab } from '../environments/environment-actions.js';
import { useEditorsStore } from '../../state/editors.js';
import { useProjectStore } from '../../state/project.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { useUiStore, type ImportDialogFormat } from '../../state/ui.js';
import { workspaceActions } from '../workspace/workspace-actions.js';
import { startRenamingProject } from './explorer-api.js';

/** The editor-tab id a project's tab opens under; stable so re-opening focuses the same tab. */
export function projectTabId(projectId: string): string {
  return `project:${projectId}`;
}

/**
 * Opens (or focuses) a project's tab: name, folder, source, `ProjectSettings`, and the
 * project's own properties table. Replaces what used to be the Details panel's project view.
 *
 * The name comes from the project mirror when it holds one, else the workspace manifest's own
 * copy — the same fallback the explorer's roots use — so the tab title is never blank while a
 * project is still opening.
 */
export function openProjectTab(projectId: string): void {
  const title =
    useProjectStore.getState().projects[projectId]?.name ??
    useWorkspaceStore.getState().workspace?.projects.find((project) => project.id === projectId)?.name ??
    'Project';
  useEditorsStore.getState().open({ id: projectTabId(projectId), kind: 'project', title, projectId });
}

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

  /** Opens the unified Import dialog with this project preselected as the target. */
  importInto(projectId: string, format?: ImportDialogFormat): void {
    projectRowActions.select(projectId);
    useUiStore.getState().openImportDialog(format);
  },

  /** Opens the Import dialog preselected to OpenAPI. */
  importOpenApiInto(projectId: string): void {
    projectRowActions.importInto(projectId, 'openapi');
  },

  /** Opens the Import dialog preselected to Postman. */
  importPostmanInto(projectId: string): void {
    projectRowActions.importInto(projectId, 'postman');
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

  /** Shows the project's settings: opens its tab, the same one a single click on the row opens. */
  settings(projectId: string): void {
    projectRowActions.select(projectId);
    openProjectTab(projectId);
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

  /** Opens the Move to Workspace dialog; nothing happens until a target is chosen and confirmed. */
  moveToWorkspace(projectId: string): void {
    useUiStore.getState().setMoveProjectDialog(projectId);
  },
};
