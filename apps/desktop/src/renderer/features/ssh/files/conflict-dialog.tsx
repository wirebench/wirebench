import { useEffect, useState } from 'react';
import * as AlertDialog from '@radix-ui/react-alert-dialog';
import type { ConflictDecisionWire, SftpConflictEvent } from '../../../../shared/sftp-wire.js';
import { formatModified, formatSize } from './format.js';

const BUTTON = 'rounded px-3 py-1.5 text-sm text-fg-default hover:bg-surface-base';

export interface ConflictDialogProps {
  /** The clash to ask about; `null` closes the dialog. */
  readonly conflict: SftpConflictEvent | null;
  readonly onAnswer: (decision: ConflictDecisionWire, applyToRest: boolean) => void;
}

function Side({ label, side }: { readonly label: string; readonly side: SftpConflictEvent['existing'] }) {
  return (
    <div className="flex flex-col" data-testid="files-conflict-side">
      <span className="text-xs text-fg-subtle">{label}</span>
      <span className="text-fg-default tabular-nums">{formatSize(side.size)}</span>
      <span className="text-xs tabular-nums">{formatModified(side.mtime)}</span>
    </div>
  );
}

/**
 * A copy would land on a name that is there already (spec R4): Skip, Keep both (`name (1).ext`) or Replace,
 * with both sides' size and time, and, while more clashes of the batch remain, a box to answer them all the
 * same way. Escape, or closing it any other way, is Skip.
 */
export function ConflictDialog({ conflict, onAnswer }: ConflictDialogProps) {
  const [applyToRest, setApplyToRest] = useState(false);
  // Each question starts with the box clear.
  useEffect(() => {
    setApplyToRest(false);
  }, [conflict?.transferId]);
  const remaining = conflict?.remaining ?? 0;
  const answer = (decision: ConflictDecisionWire) => {
    onAnswer(decision, remaining > 0 && applyToRest);
  };

  return (
    <AlertDialog.Root
      open={conflict !== null}
      onOpenChange={(open) => {
        if (!open) answer('skip');
      }}
    >
      <AlertDialog.Portal>
        <AlertDialog.Overlay className="fixed inset-0 bg-black/40" />
        <AlertDialog.Content
          data-testid="files-conflict"
          className="fixed top-1/2 left-1/2 w-96 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <AlertDialog.Title className="text-md font-medium break-all text-fg-default">
            {conflict?.name ?? ''} already exists
          </AlertDialog.Title>
          <AlertDialog.Description asChild>
            <div className="mt-3 grid grid-cols-2 gap-3 text-sm text-fg-subtle">
              {conflict !== null && (
                <>
                  <Side label="Already there" side={conflict.existing} />
                  <Side label="Being copied" side={conflict.incoming} />
                </>
              )}
            </div>
          </AlertDialog.Description>
          {remaining > 0 && (
            <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
              <input
                type="checkbox"
                checked={applyToRest}
                onChange={(event) => {
                  setApplyToRest(event.target.checked);
                }}
              />
              Do this for the {String(remaining)} other {remaining === 1 ? 'clash' : 'clashes'}
            </label>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <AlertDialog.Cancel asChild>
              <button type="button" className={BUTTON}>
                Skip
              </button>
            </AlertDialog.Cancel>
            <button
              type="button"
              className={BUTTON}
              onClick={() => {
                answer('keep-both');
              }}
            >
              Keep both
            </button>
            <button
              type="button"
              className="rounded bg-status-danger px-3 py-1.5 text-sm text-fg-on-accent"
              onClick={() => {
                answer('replace');
              }}
            >
              Replace
            </button>
          </div>
        </AlertDialog.Content>
      </AlertDialog.Portal>
    </AlertDialog.Root>
  );
}
