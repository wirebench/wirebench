import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '../components/button.js';
import { useUnsavedCloseStore } from './tab-close.js';

/**
 * Asked when a tab with unsaved edits closes (#679): Save, Don't save or Cancel. Escape, or closing it any
 * other way, is Cancel — nothing is lost by asking again.
 */
export function UnsavedCloseDialog() {
  const question = useUnsavedCloseStore((state) => state.question);
  const answer = useUnsavedCloseStore((state) => state.answer);
  return (
    <AlertDialog.Root
      open={question !== undefined}
      onOpenChange={(open) => {
        if (!open) answer('cancel');
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="unsaved-close"
          className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium break-words text-fg-default">
            Save changes to {question?.name ?? ''}?
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
            Your edits are lost if you close it without saving.
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button data-testid="unsaved-close-cancel">Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              data-testid="unsaved-close-discard"
              onClick={() => {
                answer('discard');
              }}
            >
              Don't save
            </Button>
            <Button
              variant="primary"
              data-testid="unsaved-close-save"
              autoFocus
              onClick={() => {
                answer('save');
              }}
            >
              Save
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
