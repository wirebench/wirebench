import { useEffect, useMemo, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useProjectStore } from '../../state/project.js';
import { environmentsLeftWithoutProject } from '../../state/environment-scope.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { workspaceActions } from './workspace-actions.js';

/** `“A”`, `“A” and “B”`, `“A”, “B” and “C”`. */
function quotedList(names: readonly string[]): string {
  const quoted = names.map((name) => `“${name}”`);
  return quoted.length <= 1 ? (quoted[0] ?? '') : `${quoted.slice(0, -1).join(', ')} and ${quoted.at(-1) ?? ''}`;
}

/**
 * Confirms taking a project out of the open workspace.
 *
 * A *linked* project's folder belongs to wherever the user keeps it, so it is never touched and
 * the dialog says so plainly. An *internal* project lives inside the workspace, so the dialog
 * offers to move its folder to the trash — off by default (#684): a user tidying the workspace
 * list must opt in to touching files, and an orphaned folder is recoverable where a trashed one
 * is a surprise. Trash only: nothing in the app deletes permanently.
 *
 * Removing the project also drops it from every environment's scope (#468). An environment scoped
 * to it alone is kept as *No project*, and the dialog names those first, checked here with the
 * same rule the Environments view's chips use.
 */
export function RemoveProjectDialog() {
  const projectId = useUiStore((state) => state.confirmRemoveProjectId);
  const requestRemoveProject = useUiStore((state) => state.requestRemoveProject);
  const storeName = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]?.name));
  const entry = useWorkspaceStore((state) =>
    projectId === undefined ? undefined : state.workspace?.projects.find((candidate) => candidate.id === projectId),
  );
  const workspace = useWorkspaceStore((state) => state.workspace);
  const orphaned = useMemo(
    () =>
      workspace === null || projectId === undefined
        ? []
        : environmentsLeftWithoutProject(workspace, projectId).map((environment) => environment.name),
    [workspace, projectId],
  );
  const linked = entry?.source === 'linked';
  const name = storeName ?? entry?.name;
  const [deleteFiles, setDeleteFiles] = useState(false);

  // Every opening starts from the default again, so a previous "trash the folder" choice cannot
  // silently carry over to the next project.
  useEffect(() => {
    if (projectId !== undefined) {
      setDeleteFiles(false);
    }
  }, [projectId]);

  const label = name === undefined ? 'The project' : `“${name}”`;

  return (
    <ConfirmDialog
      open={projectId !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          requestRemoveProject(undefined);
        }
      }}
      title="Remove project?"
      description={
        <>
          <span>
            {linked
              ? `${label} is removed from this workspace. It is linked, so its folder is left exactly where it is.`
              : `${label} is removed from this workspace.`}
          </span>
          {orphaned.length > 0 && (
            <span data-testid="remove-project-orphaned-environments" className="mt-2 block">
              {orphaned.length === 1
                ? `${quotedList(orphaned)} will apply to no project. It is kept, shown as No project.`
                : `${quotedList(orphaned)} will apply to no project. They are kept, shown as No project.`}
            </span>
          )}
          {!linked && (
            <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
              <input
                type="checkbox"
                data-testid="remove-project-delete-files"
                checked={deleteFiles}
                onChange={(event) => setDeleteFiles(event.target.checked)}
              />
              Move the project folder to the trash
            </label>
          )}
        </>
      }
      confirmLabel="Remove"
      destructive
      testId="remove-project-dialog"
      confirmTestId="remove-project-confirm"
      onConfirm={() => {
        if (projectId !== undefined) {
          void workspaceActions.removeProject(projectId, !linked && deleteFiles);
          requestRemoveProject(undefined);
        }
      }}
    />
  );
}
