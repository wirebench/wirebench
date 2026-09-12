import type { ReactNode } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';

export interface ConfirmDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  readonly title: string;
  readonly description: ReactNode;
  readonly confirmLabel: string;
  /** Paints the confirm button as a danger action. Set it wherever the act destroys something. */
  readonly destructive?: boolean;
  readonly onConfirm: () => void;
  /** Optional testids, so a dialog extracted from an inline copy keeps the handles it had. */
  readonly testId?: string;
  readonly confirmTestId?: string;
  readonly cancelTestId?: string;
  /**
   * Where focus lands once the dialog closes. Radix's own default tries to refocus whatever
   * opened it — but this dialog is always driven by external state, never an `AlertDialog.Trigger`,
   * so that default silently focuses nothing. Supply this to send focus somewhere specific;
   * omit it to leave Radix's (currently inert) default in place.
   */
  readonly onCloseAutoFocus?: (event: Event) => void;
}

/**
 * The one modal confirmation in the app: a title, a sentence saying what is about to happen,
 * Cancel, and the act itself. Radix's `AlertDialog` gives it the role, the focus trap and the
 * Escape handling; every caller used to spell all of that out for itself.
 */
export function ConfirmDialog({
  open,
  onOpenChange,
  title,
  description,
  confirmLabel,
  destructive = false,
  onConfirm,
  testId,
  confirmTestId,
  cancelTestId,
  onCloseAutoFocus,
}: ConfirmDialogProps) {
  return (
    <AlertDialog.Root open={open} onOpenChange={onOpenChange}>
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          {...(testId === undefined ? {} : { 'data-testid': testId })}
          {...(onCloseAutoFocus === undefined
            ? {}
            : {
                onCloseAutoFocus: (event: Event) => {
                  event.preventDefault();
                  onCloseAutoFocus(event);
                },
              })}
          className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium text-fg-default">{title}</AlertDialog.Title>
          {/* asChild swaps Radix's default `<p>` for a `<div>` — `description` is free to nest block
              content (e.g. a list), which a `<p>` can never legally contain. */}
          <AlertDialog.Description asChild>
            <div className="mt-1 text-sm text-fg-subtle">{description}</div>
          </AlertDialog.Description>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button
                type="button"
                {...(cancelTestId === undefined ? {} : { 'data-testid': cancelTestId })}
                className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base"
              >
                Cancel
              </button>
            </AlertDialog.Cancel>
            <AlertDialog.Action asChild>
              <button
                type="button"
                {...(confirmTestId === undefined ? {} : { 'data-testid': confirmTestId })}
                className={
                  destructive
                    ? 'rounded bg-status-danger px-3 py-1.5 text-sm text-fg-on-accent'
                    : 'rounded bg-accent px-3 py-1.5 text-sm text-fg-on-accent'
                }
                onClick={onConfirm}
              >
                {confirmLabel}
              </button>
            </AlertDialog.Action>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
