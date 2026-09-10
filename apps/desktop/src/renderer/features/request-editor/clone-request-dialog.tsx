/** The name prompt behind the toolbar's Clone action; defaults to `<name> (copy)`. */

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { cloneRequestAs } from './request-actions.js';

export interface CloneRequestDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly requestId: string;
  /** The source request's name; the field opens pre-filled with `<name> (copy)`. */
  readonly requestName: string;
}

/** Asks for the copy's name, then clones and opens it. */
export function CloneRequestDialog({ open, onOpenChange, requestId, requestName }: CloneRequestDialogProps) {
  const [name, setName] = useState(`${requestName} (copy)`);

  // Reopening for a different request (or after a rename) must not keep the stale suggestion.
  useEffect(() => {
    if (open) {
      setName(`${requestName} (copy)`);
    }
  }, [open, requestName]);

  const submit = (): void => {
    onOpenChange(false);
    void cloneRequestAs(requestId, name);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          className="fixed top-1/2 left-1/2 w-[24rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Clone request</Dialog.Title>
          <label className="mt-3 block text-sm text-fg-muted" htmlFor="clone-request-name">
            Name
          </label>
          <input
            id="clone-request-name"
            aria-label="Clone name"
            autoFocus
            value={name}
            onChange={(event) => setName(event.target.value)}
            onKeyDown={(event) => {
              if (event.key === 'Enter') {
                submit();
              }
            }}
            className="mt-1 h-row w-full rounded-md border border-hairline bg-surface-base px-2 text-sm text-fg-default"
          />
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button variant="primary" data-testid="clone-request-submit" onClick={submit}>
              Clone
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
