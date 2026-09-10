import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { useUiStore } from '../../state/ui.js';
import { basenameOf, projectActions } from './project-actions.js';

/**
 * Names the project whose folder the user just picked. Split from the folder picker because
 * the native dialog cannot collect a second field, and the folder's own name is nearly always
 * the right answer — so this is a confirmation with an escape hatch, not a form.
 */
export function NewProjectDialog() {
  const dir = useUiStore((state) => state.newProjectDir);
  const promptNewProject = useUiStore((state) => state.promptNewProject);
  const [name, setName] = useState('');

  useEffect(() => {
    setName(dir === undefined ? '' : basenameOf(dir));
  }, [dir]);

  const open = dir !== undefined;

  return (
    <Dialog.Root
      open={open}
      onOpenChange={(next) => {
        if (!next) {
          promptNewProject(undefined);
        }
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="new-project-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">New project</Dialog.Title>
          <Dialog.Description className="mt-1 truncate font-mono text-xs text-fg-subtle">{dir}</Dialog.Description>

          <label className="mt-3 block text-sm text-fg-subtle" htmlFor="new-project-name">
            Project name
          </label>
          <input
            id="new-project-name"
            data-testid="new-project-name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter' && dir !== undefined && name.trim().length > 0) {
                void projectActions.create(dir, name.trim());
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
              disabled={name.trim().length === 0}
              onClick={() => {
                if (dir !== undefined) {
                  void projectActions.create(dir, name.trim());
                }
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
