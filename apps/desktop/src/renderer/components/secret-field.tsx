import { useId, useState } from 'react';
import { ipc } from '../state/ipc-client.js';
import { Button } from './button.js';

export interface SecretFieldProps {
  /** The current `secretRef`, or `undefined` when nothing is set yet. */
  readonly value?: string | undefined;
  /** Called with the new `secretRef`, or `undefined` after Clear. */
  readonly onChange: (ref: string | undefined) => void;
  readonly label: string;
  readonly disabled?: boolean;
}

/**
 * A password-like field that never holds the secret itself: it stores whatever is typed via
 * `secrets.set` (or `secrets.replace` when a ref already exists, so the ref — and therefore the
 * project file referencing it — never churns) and only ever emits the resulting `secretRef`.
 *
 * At rest it shows a masked placeholder with "Replace…"/"Clear" actions; entering edit mode
 * reveals a plain `type="password"` input the user types into, which is submitted (not synced
 * character-by-character) so a half-typed value never round-trips through IPC.
 */
export function SecretField({ value, onChange, label, disabled }: SecretFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  const inputId = useId();

  async function commit(): Promise<void> {
    if (draft.length === 0) {
      setEditing(false);
      return;
    }
    setSaving(true);
    try {
      const result =
        value !== undefined
          ? await ipc().secrets.replace({ ref: value, value: draft })
          : await ipc().secrets.set({ value: draft, label });
      if (result.ok) {
        onChange(result.value.ref);
      }
    } finally {
      setSaving(false);
      setDraft('');
      setEditing(false);
    }
  }

  function clear(): void {
    onChange(undefined);
    setDraft('');
    setEditing(false);
  }

  if (editing) {
    return (
      <div className="flex items-center gap-2">
        <label className="sr-only" htmlFor={inputId}>
          {label}
        </label>
        <input
          id={inputId}
          type="password"
          autoFocus
          value={draft}
          disabled={disabled || saving}
          onChange={(e) => setDraft(e.target.value)}
          onKeyDown={(e) => {
            if (e.key === 'Enter') void commit();
            if (e.key === 'Escape') {
              setDraft('');
              setEditing(false);
            }
          }}
          placeholder="Enter password"
          className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm outline-none"
        />
        <Button onClick={() => void commit()} disabled={saving}>
          Save
        </Button>
        <Button
          onClick={() => {
            setDraft('');
            setEditing(false);
          }}
          disabled={saving}
        >
          Cancel
        </Button>
      </div>
    );
  }

  return (
    <div className="flex items-center gap-2">
      <span
        aria-label={label}
        className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-subtle"
      >
        {value !== undefined ? '••••••••' : 'Not set'}
      </span>
      <Button disabled={disabled} onClick={() => setEditing(true)}>
        {value !== undefined ? 'Replace…' : 'Set…'}
      </Button>
      {value !== undefined && (
        <Button disabled={disabled} onClick={clear}>
          Clear
        </Button>
      )}
    </div>
  );
}
