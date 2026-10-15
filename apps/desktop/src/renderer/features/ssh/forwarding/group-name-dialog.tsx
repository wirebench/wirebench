import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../../components/button.js';
import { INPUT_CLASS } from '../inherited-field.js';

const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 w-96 max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg';

/**
 * Asks for a forwarding group's name, to create one or rename one. `onSubmit` answers a problem to show, or
 * `undefined` once it is saved, which closes the dialog.
 */
export function GroupNameDialog(props: {
  readonly open: boolean;
  readonly title: string;
  readonly action: string;
  readonly initial: string;
  readonly onOpenChange: (open: boolean) => void;
  readonly onSubmit: (name: string) => Promise<string | undefined>;
}) {
  const { open, title, action, initial, onOpenChange, onSubmit } = props;
  const [name, setName] = useState(initial);
  const [error, setError] = useState<string>();
  const [busy, setBusy] = useState(false);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    setName(initial);
    setError(undefined);
  }, [open, initial]);
  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className={CONTENT_CLASS} data-testid="forward-group-dialog">
          <Dialog.Title className="text-md font-medium text-fg-default">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            Groups are kept in hosts.yaml, so everyone sharing the workspace gets them.
          </Dialog.Description>
          <form
            className="mt-3 flex flex-col gap-3"
            onSubmit={(event) => {
              event.preventDefault();
              if (name.trim() === '' || busy) return;
              setBusy(true);
              onSubmit(name.trim())
                .then((problem) => {
                  setError(problem);
                  if (problem === undefined) onOpenChange(false);
                })
                .catch((cause: unknown) => {
                  setError(cause instanceof Error ? cause.message : 'The group could not be saved');
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <label htmlFor={id} className="flex flex-col gap-1 text-xs text-fg-subtle">
              Group name
              <input
                id={id}
                autoFocus
                className={INPUT_CLASS}
                value={name}
                onChange={(event) => {
                  setName(event.target.value);
                  setError(undefined);
                }}
              />
            </label>
            {error !== undefined && (
              <p role="alert" className="text-sm text-status-danger">
                {error}
              </p>
            )}
            <div className="flex justify-end gap-2">
              <Button
                onClick={() => {
                  onOpenChange(false);
                }}
              >
                Cancel
              </Button>
              <Button type="submit" variant="primary" disabled={name.trim() === '' || busy}>
                {action}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
