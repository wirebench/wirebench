import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { workspaceActions } from './workspace-actions.js';

/**
 * Confirms taking a project out of the open workspace. Nothing is deleted here: the folder
 * stays where it is, whether it lives inside the workspace or is linked from elsewhere — so
 * this dialog says so rather than warning about a loss that is not happening.
 */
export function RemoveProjectDialog() {
  const projectId = useUiStore((state) => state.confirmRemoveProjectId);
  const requestRemoveProject = useUiStore((state) => state.requestRemoveProject);
  const name = useProjectStore((state) => (projectId === undefined ? undefined : state.projects[projectId]?.name));

  return (
    <ConfirmDialog
      open={projectId !== undefined}
      onOpenChange={(open) => {
        if (!open) {
          requestRemoveProject(undefined);
        }
      }}
      title="Remove project?"
      description={`${name === undefined ? 'The project' : `“${name}”`} is removed from this workspace. Its folder is left on disk.`}
      confirmLabel="Remove"
      destructive
      testId="remove-project-dialog"
      confirmTestId="remove-project-confirm"
      onConfirm={() => {
        if (projectId !== undefined) {
          void workspaceActions.removeProject(projectId);
          requestRemoveProject(undefined);
        }
      }}
    />
  );
}
