import { useEffect, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import { Button } from '../components/button.js';
import { useLiveCloseStore, type LiveCloseQuestion } from './tab-close.js';

/** "Close the session on box?", "Close 2 sessions on box?", or "Close 3 sessions in 2 tabs?". */
export function liveCloseTitle(question: LiveCloseQuestion): string {
  const sessions = question.sessions === 1 ? 'the session' : `${String(question.sessions)} sessions`;
  return question.tabs === 1
    ? `Close ${sessions} on ${question.name}?`
    : `Close ${sessions} in ${String(question.tabs)} tabs?`;
}

/**
 * Asked once when closing tabs that hold live sessions (S53): Close ends them, Cancel keeps every tab. Escape,
 * or closing it any other way, is Cancel. "Don't ask again" turns the question off; Settings → Terminal has it.
 */
export function LiveCloseDialog() {
  const question = useLiveCloseStore((state) => state.question);
  const answer = useLiveCloseStore((state) => state.answer);
  const [dontAskAgain, setDontAskAgain] = useState(false);
  useEffect(() => {
    setDontAskAgain(false);
  }, [question]);
  return (
    <AlertDialog.Root
      open={question !== undefined}
      onOpenChange={(open) => {
        if (!open) answer({ close: false, dontAskAgain: false });
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="live-close"
          className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium break-words text-fg-default">
            {question === undefined ? '' : liveCloseTitle(question)}
          </AlertDialog.Title>
          <AlertDialog.Description className="mt-1 text-sm text-fg-subtle">
            Closing ends the connection, and whatever runs in it stops.
          </AlertDialog.Description>
          <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
            <input
              type="checkbox"
              checked={dontAskAgain}
              onChange={(e) => {
                setDontAskAgain(e.currentTarget.checked);
              }}
            />
            Don't ask again
          </label>
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <Button data-testid="live-close-cancel">Cancel</Button>
            </AlertDialog.Cancel>
            <Button
              variant="primary"
              data-testid="live-close-confirm"
              autoFocus
              onClick={() => {
                answer({ close: true, dontAskAgain });
              }}
            >
              Close
            </Button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
