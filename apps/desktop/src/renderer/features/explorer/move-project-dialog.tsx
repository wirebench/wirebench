import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useProjectStore } from '../../state/project.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import { workspaceActions } from '../workspace/workspace-actions.js';

/**
 * *Move to workspace…*: moves one project out of the open workspace and into another one on
 * disk, closed or not. A native `<select>` rather than Radix's — no `@radix-ui/react-select`
 * dependency exists in the app yet, and a plain select needs none. The move itself always asks
 * first, since it moves the project's files here to the trash.
 */
export function MoveProjectDialog() {
  const projectId = useUiStore((state) => state.moveProjectDialog);
  const setProjectId = useUiStore((state) => state.setMoveProjectDialog);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const storeName = useProjectStore((state) => (projectId === null ? undefined : state.projects[projectId]?.name));
  const entry = useWorkspaceStore((state) =>
    projectId === null ? undefined : state.workspace?.projects.find((candidate) => candidate.id === projectId),
  );
  const name = storeName ?? entry?.name;

  const targets = workspaces.filter((candidate) => candidate.id !== workspace?.id && candidate.unreadable !== true);
  const [targetId, setTargetId] = useState<string | undefined>(undefined);
  const [confirmOpen, setConfirmOpen] = useState(false);

  useEffect(() => {
    if (projectId !== null) {
      setTargetId(targets[0]?.id);
      setConfirmOpen(false);
    }
  }, [projectId]);

  const close = (): void => {
    setProjectId(null);
  };

  const target = targets.find((candidate) => candidate.id === targetId);
  const label = name === undefined ? 'The project' : `“${name}”`;

  return (
    <>
      <Dialog.Root
        open={projectId !== null}
        onOpenChange={(next) => {
          if (!next) {
            close();
          }
        }}
      >
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="move-project-dialog"
            className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
          >
            <Dialog.Title className="text-md font-medium text-fg-default">Move to workspace</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-fg-subtle">
              {label} moves into the target workspace's own folder; nothing is left behind here but the trash.
            </Dialog.Description>

            <label className="mt-3 block text-sm text-fg-subtle" htmlFor="move-project-target">
              Target workspace
            </label>
            {targets.length === 0 ? (
              <p className="mt-1 text-sm text-fg-subtle">No other workspace to move it to.</p>
            ) : (
              <select
                id="move-project-target"
                data-testid="move-project-target"
                value={targetId}
                onChange={(event) => setTargetId(event.target.value)}
                className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
              >
                {targets.map((candidate) => (
                  <option key={candidate.id} value={candidate.id}>
                    {candidate.name}
                  </option>
                ))}
              </select>
            )}

            <div className="mt-4 flex justify-end gap-2">
              <Dialog.Close asChild>
                <Button>Cancel</Button>
              </Dialog.Close>
              <Button
                data-testid="move-project-submit"
                variant="primary"
                disabled={targetId === undefined}
                onClick={() => setConfirmOpen(true)}
              >
                Move…
              </Button>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={confirmOpen}
        onOpenChange={(next) => {
          if (!next) {
            setConfirmOpen(false);
          }
        }}
        title="Move project?"
        description={`${label} moves to ${target?.name ?? 'the other workspace'}; its files here go to the trash.`}
        confirmLabel="Move"
        destructive
        confirmTestId="move-project-confirm"
        onConfirm={() => {
          if (projectId !== null && target !== undefined) {
            void workspaceActions.moveProject(projectId, target.id);
          }
          setConfirmOpen(false);
          close();
        }}
      />
    </>
  );
}
