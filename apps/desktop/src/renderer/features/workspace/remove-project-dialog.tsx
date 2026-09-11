import { useEffect, useState } from 'react';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { workspaceActions } from './workspace-actions.js';

/**
 * Confirms taking a project out of the open workspace.
 *
 * A *linked* project's folder belongs to wherever the user keeps it, so it is never touched and
 * the dialog says so plainly. An *internal* project lives inside the workspace, so the dialog
 * offers to move its folder to the trash — on by default, because leaving an orphaned folder
 * behind in the workspace is the surprising outcome, not the safe one. Trash only: nothing in
 * the app deletes permanently.
 */
export function RemoveProjectDialog() {
  const projectId = useUiStore((state) => state.confirmRemoveProjectId);
  const requestRemoveProject = useUiStore((state) => state.requestRemoveProject);
  const storeName = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]?.name));
  const entry = useWorkspaceStore((state) =>
    projectId === undefined ? undefined : state.workspace?.projects.find((candidate) => candidate.id === projectId),
  );
  const linked = entry?.source === 'linked';
  const name = storeName ?? entry?.name;
  const [deleteFiles, setDeleteFiles] = useState(true);

  // Every opening starts from the default again, so a previous "keep the folder" choice cannot
  // silently carry over to the next project.
  useEffect(() => {
    if (projectId !== undefined) {
      setDeleteFiles(true);
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
        linked ? (
          `${label} is removed from this workspace. It is linked, so its folder is left exactly where it is.`
        ) : (
          <>
            <span>{`${label} is removed from this workspace.`}</span>
            <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
              <input
                type="checkbox"
                data-testid="remove-project-delete-files"
                checked={deleteFiles}
                onChange={(event) => setDeleteFiles(event.target.checked)}
              />
              Move the project folder to the trash
            </label>
          </>
        )
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
