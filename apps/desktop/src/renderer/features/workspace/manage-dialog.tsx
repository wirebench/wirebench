import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Trash2 } from 'lucide-react';
import { Button } from '../../components/button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
import { useUiStore } from '../../state/ui.js';
import { useWorkspaceStore } from '../../state/workspace.js';
import type { WorkspaceSummaryWire } from '../../../shared/wire-types.js';
import { workspaceActions } from './workspace-actions.js';

function plural(count: number, noun: string): string {
  return `${String(count)} ${noun}${count === 1 ? '' : 's'}`;
}

/**
 * How many projects live *inside* a workspace's own folder, and so go to the trash with it.
 * Only the open workspace tells the renderer which of its projects are linked; for the others
 * the summary's count is all there is, so it is used as the upper bound it is.
 */
function internalProjectCount(
  row: WorkspaceSummaryWire,
  openId: string | undefined,
  open: readonly { source: string }[],
): number {
  return row.id === openId ? open.filter((project) => project.source === 'internal').length : row.projectCount;
}

/**
 * *Manage workspaces…*: one row per workspace, its name editable in place, and a way to delete
 * it. Renaming commits on Enter or on blur; deleting always asks first, and says what goes to
 * the trash — the workspace folder and the projects stored inside it, never a linked folder.
 */
export function WorkspaceManageDialog() {
  const open = useUiStore((state) => state.workspaceManageOpen);
  const setOpen = useUiStore((state) => state.setWorkspaceManageOpen);
  const workspaces = useWorkspaceStore((state) => state.workspaces);
  const workspace = useWorkspaceStore((state) => state.workspace);
  const list = useWorkspaceStore((state) => state.list);
  const [pendingDelete, setPendingDelete] = useState<WorkspaceSummaryWire | undefined>(undefined);

  useEffect(() => {
    if (open) {
      void list();
    }
  }, [open, list]);

  const commitRename = (row: WorkspaceSummaryWire, value: string): void => {
    const trimmed = value.trim();
    if (trimmed.length === 0 || trimmed === row.name) {
      return;
    }
    void workspaceActions.rename(row.id, trimmed);
  };

  return (
    <>
      <Dialog.Root open={open} onOpenChange={setOpen}>
        <Dialog.Portal>
          <Dialog.Overlay className="fixed inset-0 bg-black/40" />
          <Dialog.Content
            data-testid="workspace-manage-dialog"
            className="fixed top-1/2 left-1/2 w-[34rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
          >
            <Dialog.Title className="text-md font-medium text-fg-default">Manage workspaces</Dialog.Title>
            <Dialog.Description className="mt-1 text-xs text-fg-subtle">
              Rename a workspace in place, or delete one. Deleting never touches a linked project folder.
            </Dialog.Description>

            {workspaces.length === 0 ? (
              <p className="mt-4 text-sm text-fg-subtle">No workspaces yet.</p>
            ) : (
              <ul className="mt-3 flex max-h-80 flex-col overflow-auto">
                {workspaces.map((row) => (
                  <li key={row.id} data-workspace-id={row.id} className="flex items-center gap-2 py-1">
                    <input
                      data-testid="workspace-rename-name"
                      data-workspace-id={row.id}
                      aria-label={`Name of ${row.name}`}
                      defaultValue={row.name}
                      // The row is keyed by id and the value is uncontrolled, so a rename that
                      // reorders the list does not yank the field out from under the caret.
                      key={`${row.id}:${row.name}`}
                      onKeyDown={(event) => {
                        if (event.key === 'Enter') {
                          event.preventDefault();
                          event.currentTarget.blur();
                        }
                      }}
                      onBlur={(event) => {
                        commitRename(row, event.target.value);
                      }}
                      className="h-row w-48 shrink-0 rounded border border-hairline-strong bg-surface-base px-2 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
                    />
                    <span className="min-w-0 flex-1 truncate font-mono text-xs text-fg-subtle" title={row.dir}>
                      {row.dir}
                    </span>
                    <span className="shrink-0 text-xs text-fg-faint">{plural(row.projectCount, 'project')}</span>
                    <button
                      type="button"
                      data-testid="workspace-delete"
                      data-workspace-id={row.id}
                      aria-label={`Delete ${row.name}`}
                      onClick={() => {
                        setPendingDelete(row);
                      }}
                      className="inline-flex size-7 shrink-0 items-center justify-center rounded-md text-fg-subtle transition-colors hover:bg-surface-hover hover:text-status-danger"
                    >
                      <Trash2 size={14} aria-hidden="true" />
                    </button>
                  </li>
                ))}
              </ul>
            )}

            <div className="mt-4 flex justify-end">
              <Dialog.Close asChild>
                <Button>Close</Button>
              </Dialog.Close>
            </div>
          </Dialog.Content>
        </Dialog.Portal>
      </Dialog.Root>

      <ConfirmDialog
        open={pendingDelete !== undefined}
        onOpenChange={(next) => {
          if (!next) {
            setPendingDelete(undefined);
          }
        }}
        title="Delete workspace?"
        description={
          pendingDelete === undefined
            ? ''
            : `“${pendingDelete.name}” and the ${plural(
                internalProjectCount(pendingDelete, workspace?.id, workspace?.projects ?? []),
                'project',
              )} stored inside it go to the trash. Linked project folders are left where they are.`
        }
        confirmLabel="Delete"
        destructive
        confirmTestId="workspace-delete-confirm"
        onConfirm={() => {
          if (pendingDelete === undefined) {
            return;
          }
          // Deleting the open workspace drops the app back to the picker, where a dialog
          // floating over it would make no sense.
          if (pendingDelete.id === workspace?.id) {
            setOpen(false);
          }
          void workspaceActions.remove(pendingDelete.id);
          setPendingDelete(undefined);
        }}
      />
    </>
  );
}
