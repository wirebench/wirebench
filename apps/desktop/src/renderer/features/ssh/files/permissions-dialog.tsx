import { useState } from 'react';
import * as Dialog from '@radix-ui/react-dialog';
import { Button } from '../../../components/button.js';
import { modeString } from './format.js';

const WHO = [
  { label: 'Owner', shift: 6 },
  { label: 'Group', shift: 3 },
  { label: 'Others', shift: 0 },
] as const;
const WHAT = [
  { label: 'Read', bit: 4 },
  { label: 'Write', bit: 2 },
  { label: 'Execute', bit: 1 },
] as const;

/** The nine bits the dialog edits; set-id and sticky bits are kept as they were. */
const SHOWN = 0o777;

/** Three octal digits, or `undefined`. */
export function parseOctal(text: string): number | undefined {
  return /^[0-7]{3}$/.test(text.trim()) ? Number.parseInt(text.trim(), 8) : undefined;
}

export function octalOf(mode: number): string {
  return (mode & SHOWN).toString(8).padStart(3, '0');
}

export interface PermissionsDialogProps {
  /** The entry's name and its current mode; `null` closes the dialog. */
  readonly target: { readonly name: string; readonly mode: number } | null;
  readonly onCancel: () => void;
  /** The whole new mode, the bits it does not show included. */
  readonly onApply: (mode: number) => void;
}

/**
 * Owner, group and others read/write/execute boxes and an octal field kept in step: ticking a box rewrites
 * the field, a valid three-digit field ticks the boxes, an invalid one disables Apply.
 */
export function PermissionsDialog({ target, onCancel, onApply }: PermissionsDialogProps) {
  return (
    <Dialog.Root
      open={target !== null}
      onOpenChange={(open) => {
        if (!open) onCancel();
      }}
    >
      <Dialog.Portal>
        <Dialog.Overlay className="fixed inset-0 bg-black/40" />
        {target !== null && <PermissionsBody key={target.name} target={target} onCancel={onCancel} onApply={onApply} />}
      </Dialog.Portal>
    </Dialog.Root>
  );
}

function PermissionsBody({
  target,
  onCancel,
  onApply,
}: {
  readonly target: { readonly name: string; readonly mode: number };
  readonly onCancel: () => void;
  readonly onApply: (mode: number) => void;
}) {
  const [bits, setBits] = useState(target.mode & SHOWN);
  const [text, setText] = useState(octalOf(target.mode));
  const typed = parseOctal(text);
  const kept = target.mode & ~SHOWN;

  const toggle = (mask: number, on: boolean): void => {
    const next = on ? bits | mask : bits & ~mask;
    setBits(next);
    setText(octalOf(next));
  };

  return (
    <Dialog.Content
      data-testid="files-permissions"
      aria-describedby={undefined}
      className="fixed top-1/2 left-1/2 w-80 -translate-x-1/2 -translate-y-1/2 rounded-md bg-surface-raised p-4 shadow-lg"
    >
      <Dialog.Title className="truncate text-md font-medium text-fg-default">Permissions of {target.name}</Dialog.Title>
      <table className="mt-3 w-full text-sm text-fg-default">
        <thead>
          <tr className="text-xs text-fg-subtle">
            <th />
            {WHAT.map((what) => (
              <th key={what.label} className="font-normal">
                {what.label}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {WHO.map((who) => (
            <tr key={who.label}>
              <th scope="row" className="py-1 text-left font-normal">
                {who.label}
              </th>
              {WHAT.map((what) => {
                const mask = what.bit << who.shift;
                return (
                  <td key={what.label} className="text-center">
                    <input
                      type="checkbox"
                      aria-label={`${who.label} ${what.label.toLowerCase()}`}
                      checked={(bits & mask) !== 0}
                      onChange={(e) => {
                        toggle(mask, e.target.checked);
                      }}
                    />
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>
      <label className="mt-3 flex items-center gap-2 text-sm text-fg-default">
        Octal
        <input
          aria-label="Octal mode"
          aria-invalid={typed === undefined}
          value={text}
          maxLength={3}
          onChange={(e) => {
            setText(e.target.value);
            const parsed = parseOctal(e.target.value);
            if (parsed !== undefined) setBits(parsed);
          }}
          className="w-16 rounded border border-hairline bg-surface-sunken px-2 py-0.5 font-mono aria-invalid:border-status-danger"
        />
        <span className="font-mono text-xs text-fg-subtle">{modeString(kept | (typed ?? bits))}</span>
      </label>
      <div className="mt-4 flex justify-end gap-2">
        <Button onClick={onCancel}>Cancel</Button>
        <Button
          variant="primary"
          disabled={typed === undefined}
          onClick={() => {
            if (typed !== undefined) onApply(kept | typed);
          }}
        >
          Apply
        </Button>
      </div>
    </Dialog.Content>
  );
}
