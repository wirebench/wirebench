import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { useUiStore } from '../../state/ui.js';
import { workspaceActions } from './workspace-actions.js';

/**
 * Names a new workspace from inside the IDE — the switcher's *Create workspace…*. It asks for
 * exactly what the picker's create form asks for, and carries the same testids, so the two can
 * never drift; only one of them is ever mounted, since the picker shows only with no workspace
 * open. Creating opens the new workspace, which closes the current one (main saves it first).
 */
export function CreateWorkspaceDialog() {
  const open = useUiStore((state) => state.workspaceCreateOpen);
  const setOpen = useUiStore((state) => state.setWorkspaceCreateOpen);
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
    await workspaceActions.create(trimmed);
    setBusy(false);
    setOpen(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={setOpen}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="create-workspace-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Create workspace</Dialog.Title>
          <Dialog.Description className="mt-1 text-xs text-fg-subtle">
            The new workspace opens straight away; this one is saved and closed.
          </Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="create-workspace-name">
            Workspace name
          </label>
          <input
            id="create-workspace-name"
            data-testid="workspace-create-name"
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
              data-testid="workspace-create"
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
