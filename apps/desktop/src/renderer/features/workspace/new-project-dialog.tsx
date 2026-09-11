import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { useUiStore } from '../../state/ui.js';
import { workspaceActions } from './workspace-actions.js';

/**
 * Names a new project of the open workspace. A name is all it asks: the folder is the
 * workspace's own `projects/<slug>/`, so there is nothing else to choose.
 */
export function NewProjectDialog() {
  const open = useUiStore((state) => state.newProjectDialogOpen);
  const setOpen = useUiStore((state) => state.setNewProjectDialogOpen);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);

  useEffect(() => {
    if (open) {
      setName('');
    }
  }, [open]);

  const trimmed = name.trim();
  const submit = async (): Promise<void> => {
    if (trimmed.length === 0 || busy) {
      return;
    }
    setBusy(true);
    const projectId = await workspaceActions.addProject(trimmed);
    setBusy(false);
    if (projectId !== undefined) {
      setOpen(false);
    }
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="new-project-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">New project</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            The project is created inside this workspace.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            data-testid="new-project-name"
            autoFocus
            value={name}
            onChange={(event) => {
              setName(event.target.value);
            }}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                event.preventDefault();
                void submit();
              }
            }}
            className="mt-1 w-full rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent"
          />

          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              data-testid="new-project-create"
              variant="primary"
              disabled={trimmed.length === 0 || busy}
              onClick={() => {
                void submit();
              }}
            >
              Create
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
