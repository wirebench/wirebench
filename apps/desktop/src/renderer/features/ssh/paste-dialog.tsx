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
  /** How many panes a broadcast takes the paste to; above one, the dialog says so and offers no "Don't ask again". */
  readonly receivers?: number | undefined;
}

/**
 * Asks before a multi-line paste reaches the shell. Shows the first lines, how many more there are, and a
 * "Don't ask again" box. Paste is the default button; Cancel closes without sending.
 */
export function PasteDialog(props: PasteDialogProps) {
  // Keyed so a later paste starts with the box unticked.
  return <PasteDialogBody key={props.text ?? ''} {...props} />;
}

function PasteDialogBody({ text, onConfirm, onCancel, receivers = 1 }: PasteDialogProps) {
  const broadcast = receivers > 1;
  const panes = `${String(receivers)} panes`;
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
          <Dialog.Title className="text-md font-medium text-fg-default">
            {broadcast ? `Paste to ${panes}?` : 'Paste multiple lines?'}
          </Dialog.Title>
          <Dialog.Description className="mt-1 text-sm text-fg-subtle">
            {broadcast
              ? `Broadcast is on: the paste goes to all ${panes} at once.`
              : 'A pasted script runs line by line in the shell.'}
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
          {!broadcast && (
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
          )}
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
                onConfirm(!broadcast && dontAsk);
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
