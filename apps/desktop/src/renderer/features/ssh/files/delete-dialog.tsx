import { ConfirmDialog } from '../../../components/confirm-dialog.js';

/** Names shown before "and n more". */
const LISTED = 8;

export interface DeleteDialogProps {
  /** What is about to go; `null` closes the dialog. */
  readonly target: { readonly names: readonly string[]; readonly folders: boolean } | null;
  readonly onCancel: () => void;
  readonly onConfirm: () => void;
}

/** Lists what is about to be deleted, and says a folder goes with everything in it. */
export function DeleteDialog({ target, onCancel, onConfirm }: DeleteDialogProps) {
  const names = target?.names ?? [];
  const more = names.length - LISTED;
  return (
    <ConfirmDialog
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
      title={names.length === 1 ? `Delete ${names[0] ?? ''}?` : `Delete ${String(names.length)} items?`}
      description={
        <span className="flex flex-col gap-2">
          <span className="flex flex-col font-mono text-xs text-fg-default">
            {names.slice(0, LISTED).map((name) => (
              <span key={name} className="truncate">
                {name}
              </span>
            ))}
            {more > 0 && <span className="font-sans text-fg-subtle">and {String(more)} more</span>}
          </span>
          <span>
            {target?.folders === true
              ? 'Folders are deleted with everything in them. This cannot be undone.'
              : 'This cannot be undone.'}
          </span>
        </span>
      }
      confirmLabel="Delete"
      destructive
      onConfirm={onConfirm}
      testId="files-delete"
      confirmTestId="files-delete-confirm"
    />
  );
}
