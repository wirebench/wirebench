import { useEffect, useId, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../../components/button.js';
import { showToast } from '../../../components/toast.js';
import { useLayoutsStore } from './layouts-store.js';
import { layoutOfTab, linkTabToLayout, savableTreeOf } from './open-layout.js';

const FIELD_CLASS =
  'w-full rounded-md border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent';
const CONTENT_CLASS =
  'fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg';

const NOTHING_TO_SAVE = 'No pane’s host is in hosts.yaml any more, so there is nothing to save.';

/**
 * Asks for a layout's name. `onSubmit` answers an error message to show (a name already used, say), or
 * `undefined` once it is done, which closes the dialog.
 */
export function LayoutNameDialog(props: {
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
        <Dialog.Content className={CONTENT_CLASS} data-testid="layout-name-dialog">
          <Dialog.Title className="text-md font-medium text-fg-default">{title}</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            Layouts are kept on this machine, for this workspace.
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
                  setError(cause instanceof Error ? cause.message : 'The layout could not be saved');
                })
                .finally(() => {
                  setBusy(false);
                });
            }}
          >
            <label htmlFor={id} className="flex flex-col gap-1 text-xs text-fg-subtle">
              Layout name
              <input
                id={id}
                autoFocus
                className={FIELD_CLASS}
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
              <Button variant="primary" type="submit" disabled={name.trim() === '' || busy}>
                {action}
              </Button>
            </div>
          </form>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}

/** Saves the tab's tree as a new layout named `name` and links the tab to it; answers an error to show. */
async function saveAsNew(tabId: string, name: string): Promise<string | undefined> {
  const root = savableTreeOf(tabId);
  if (root === undefined) return NOTHING_TO_SAVE;
  const result = await useLayoutsStore.getState().save({ name, root });
  if (!result.ok) return result.error.message;
  linkTabToLayout(tabId, result.value.id);
  showToast(`Saved layout “${result.value.name}”`);
  return undefined;
}

/**
 * **Save layout…** for a terminal tab. A tab never saved asks for a name; a tab opened from (or saved as) a
 * layout offers **Update "<name>"**, which keeps the name, or **Save as new…**. Ratios are saved as they are;
 * a pane on a host gone from `hosts.yaml` is left out.
 */
export function SaveLayoutDialog({
  tabId,
  open,
  onOpenChange,
}: {
  readonly tabId: string;
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
}) {
  // Read on each open: the tab may have been saved, or its layout deleted, since.
  const existing = open ? layoutOfTab(tabId) : undefined;
  const [asNew, setAsNew] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    if (!open) return;
    setAsNew(false);
    setError(undefined);
  }, [open]);

  if (existing === undefined || asNew) {
    return (
      <LayoutNameDialog
        open={open}
        title="Save layout"
        action="Save"
        initial=""
        onOpenChange={onOpenChange}
        onSubmit={(name) => saveAsNew(tabId, name)}
      />
    );
  }

  const update = async (): Promise<void> => {
    const root = savableTreeOf(tabId);
    if (root === undefined) {
      setError(NOTHING_TO_SAVE);
      return;
    }
    const result = await useLayoutsStore.getState().save({ id: existing.id, name: existing.name, root });
    if (!result.ok) {
      setError(result.error.message);
      return;
    }
    showToast(`Updated layout “${existing.name}”`);
    onOpenChange(false);
  };

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content className={CONTENT_CLASS} data-testid="save-layout-dialog">
          <Dialog.Title className="text-md font-medium text-fg-default">Save layout</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            This tab was opened from “{existing.name}”. Update it to this tab’s panes, or keep it and save a new one.
          </Dialog.Description>
          {error !== undefined && (
            <p role="alert" className="mt-3 text-sm text-status-danger">
              {error}
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Button
              onClick={() => {
                onOpenChange(false);
              }}
            >
              Cancel
            </Button>
            <Button
              onClick={() => {
                setAsNew(true);
              }}
            >
              Save as new…
            </Button>
            <Button
              variant="primary"
              autoFocus
              onClick={() => {
                update().catch(() => {
                  setError('The layout could not be saved');
                });
              }}
            >
              Update “{existing.name}”
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
