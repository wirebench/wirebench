/** The picker behind *Send to environments…*: which environments to send to, and the baseline. */

import { useEffect, useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../components/button.js';
import { MAX_SEND_ENVIRONMENTS } from '../../../shared/multi-env-limits.js';
import { canSend, initialSelection, pickBaseline, type EnvSelection, type PickerEnvironment } from './env-picker.js';

export interface EnvPickerDialogProps {
  readonly open: boolean;
  readonly onOpenChange: (open: boolean) => void;
  /** The project's environments, in order. */
  readonly environments: readonly PickerEnvironment[];
  readonly activeId: string | undefined;
  /** The selection last sent for this request, this session. */
  readonly remembered?: EnvSelection | undefined;
  readonly onSend: (selection: EnvSelection) => void;
}

/** One checkbox and one *Baseline* radio per environment; Send needs two ticked. */
export function EnvPickerDialog({
  open,
  onOpenChange,
  environments,
  activeId,
  remembered,
  onSend,
}: EnvPickerDialogProps) {
  const [selection, setSelection] = useState<EnvSelection>(() => initialSelection(environments, activeId, remembered));

  // Each opening starts from what is remembered, not from where the last one was left.
  useEffect(() => {
    if (open) {
      setSelection(initialSelection(environments, activeId, remembered));
    }
  }, [open, environments, activeId, remembered]);

  const toggle = (id: string, on: boolean): void => {
    setSelection((current) => {
      const ticked = environments
        .map((environment) => environment.id)
        .filter((candidate) => (candidate === id ? on : current.ticked.includes(candidate)));
      return { ticked, baseline: pickBaseline(ticked, current.baseline, activeId) };
    });
  };

  const tooMany = selection.ticked.length > MAX_SEND_ENVIRONMENTS;
  const sendable = canSend(selection) && !tooMany;

  return (
    <Dialog.Root open={open} onOpenChange={onOpenChange}>
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        <Dialog.Content
          aria-describedby={undefined}
          data-testid="env-picker"
          className="fixed top-1/2 left-1/2 w-[26rem] -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
        >
          <Dialog.Title className="text-md font-medium text-fg-default">Send to environments</Dialog.Title>
          <p className="mt-1 text-sm text-fg-muted">Tick two or more. The others are compared against the baseline.</p>
          <ul aria-label="Environments" className="mt-3 flex max-h-72 flex-col gap-1 overflow-auto">
            {environments.map((environment) => {
              const ticked = selection.ticked.includes(environment.id);
              return (
                <li key={environment.id} className="flex items-center justify-between gap-3 text-sm">
                  <label className="flex min-w-0 items-center gap-2 text-fg-default">
                    <input
                      type="checkbox"
                      aria-label={`Include ${environment.name}`}
                      checked={ticked}
                      onChange={(event) => toggle(environment.id, event.target.checked)}
                    />
                    <span className="truncate">{environment.name}</span>
                  </label>
                  <label className="flex shrink-0 items-center gap-1 text-xs text-fg-subtle">
                    <input
                      type="radio"
                      name="env-picker-baseline"
                      aria-label={`Baseline ${environment.name}`}
                      disabled={!ticked}
                      checked={selection.baseline === environment.id}
                      onChange={() => setSelection((current) => ({ ...current, baseline: environment.id }))}
                    />
                    Baseline
                  </label>
                </li>
              );
            })}
          </ul>
          {tooMany && (
            <p role="alert" className="mt-2 text-xs text-status-danger">
              At most {MAX_SEND_ENVIRONMENTS} environments at once.
            </p>
          )}
          <div className="mt-4 flex justify-end gap-2">
            <Dialog.Close asChild>
              <Button>Cancel</Button>
            </Dialog.Close>
            <Button
              variant="primary"
              data-testid="env-picker-send"
              disabled={!sendable}
              onClick={() => onSend(selection)}
            >
              Send
            </Button>
          </div>
        </Dialog.Content>
      </Dialog.Portal>
    </Dialog.Root>
  );
}
