import { useRef, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { pastePreview } from './paste-guard.js';

export interface PasteDialogProps {
  /** The held paste; the dialog is open while this is set. */
  readonly text: string | null;
  /** Paste was chosen; `dontAskAgain` carries the checkbox. */
  readonly onConfirm: (dontAskAgain: boolean) => void;
  /** Cancel, Escape or a click outside: nothing is sent. */
  readonly onCancel: () => void;
}

/**
 * Asks before a multi-line paste reaches the shell. Shows the first lines, how many more there are, and a
 * "Don't ask again" box. Paste is the default button; Cancel closes without sending.
 */
export function PasteDialog({ text, onConfirm, onCancel }: PasteDialogProps) {
  // Keyed so a later paste starts with the box unticked.
  return <PasteDialogBody key={text ?? ''} text={text} onConfirm={onConfirm} onCancel={onCancel} />;
}

function PasteDialogBody({ text, onConfirm, onCancel }: PasteDialogProps) {
  const [dontAsk, setDontAsk] = useState(false);
  const pasteButton = useRef<HTMLButtonElement>(null);
  const preview = text === null ? undefined : pastePreview(text);
  return (
    <Dialog.Root
      open={text !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          data-testid="paste-dialog"
          className="fixed top-1/2 left-1/2 w-[28rem] max-w-[calc(100vw-2rem)] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
          onOpenAutoFocus={(event) => {
            // Paste is the default action, so Enter confirms; Cancel and Escape stay one keypress away.
            event.preventDefault();
            pasteButton.current?.focus();
          }}
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Paste multiple lines?</Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            A pasted script runs line by line in the shell.
          </Dialog.Description>
          {preview !== undefined && (
            <div className="mt-2">
              <pre
                data-testid="paste-preview"
                className="max-h-40 overflow-auto rounded border border-hairline bg-surface-sunken p-2 font-mono text-xs whitespace-pre text-fg-default"
              >
                {preview.lines.join('\n')}
              </pre>
              {preview.remaining > 0 && (
                <div className="mt-1 text-xs text-fg-subtle">
                  {`+ ${String(preview.remaining)} more ${preview.remaining === 1 ? 'line' : 'lines'}`}
                </div>
              )}
            </div>
          )}
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
            <input
              type="checkbox"
              checked={dontAsk}
              onChange={(e) => {
                setDontAsk(e.target.checked);
              }}
            />
            Don&apos;t ask again
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <button
              type="button"
              className="rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base"
              onClick={onCancel}
            >
              Cancel
            </button>
            <button
              ref={pasteButton}
              type="button"
              className="rounded bg-accent px-3 py-1.5 text-sm text-fg-on-accent"
              onClick={() => {
                onConfirm(dontAsk);
              }}
            >
              Paste
            </button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
