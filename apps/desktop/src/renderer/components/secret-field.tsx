import { useEffect, useId, useRef, useState } from 'react';
import { ipc } from '../state/ipc-client.js';
import { Button } from './button.js';

export interface SecretFieldProps {
  /** The current `secretRef`, or `undefined` when nothing is set yet. */
  readonly value?: string | undefined;
  /** Called with the new `secretRef`, or `undefined` after Clear. */
  readonly onChange: (ref: string | undefined) => void;
  readonly label: string;
  readonly disabled?: boolean;
  /**
   * Receives a "flush" callback the owner can await before submitting its form: a value the
   * user typed but never pressed Save on is stored then (returning the fresh ref) rather than
   * silently dropped. Called again with `undefined` on unmount.
   */
  readonly registerFlush?: (flush: (() => Promise<string | undefined>) | undefined) => void;
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
export function SecretField({ value, onChange, label, disabled, registerFlush }: SecretFieldProps) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState('');
  const [saving, setSaving] = useState(false);
  // Whether `value`'s secret has a value in this machine's local store. Kept 'unknown' (which
  // renders exactly like 'present', to avoid flicker) until a probe confirms one way or the
  // other — only a confirmed `exists → false` shows the "Not on this machine" state.
  const [presence, setPresence] = useState<'unknown' | 'present' | 'missing'>('unknown');
  const inputId = useId();
  // `commit` is recreated every render (it closes over the draft), so the flush callback is
  // kept in a ref and re-pointed rather than re-registered on every keystroke.
  const commitRef = useRef<() => Promise<string | undefined>>(() => Promise.resolve(value));

  async function commit(): Promise<string | undefined> {
    if (draft.length === 0) {
      setEditing(false);
      return value;
    }
    setSaving(true);
    try {
      const result =
        value !== undefined
          ? await ipc().secrets.replace({ ref: value, value: draft })
          : await ipc().secrets.set({ value: draft, label });
      if (result.ok) {
        setPresence('present');
        onChange(result.value.ref);
        return result.value.ref;
      }
      return value;
    } finally {
      setSaving(false);
      setDraft('');
      setEditing(false);
    }
  }

  commitRef.current = commit;

  useEffect(() => {
    registerFlush?.(() => commitRef.current());
    return () => {
      registerFlush?.(undefined);
    };
  }, [registerFlush]);

  // Probes whether `value`'s ref has a value on this machine. In a shared workspace a secret
  // ref travels with the project files while the value itself stays in each member's local
  // keychain-backed store, so a teammate who joins sees the ref with nothing behind it here.
  useEffect(() => {
    if (value === undefined || disabled === true) {
      setPresence('unknown');
      return;
    }
    let cancelled = false;
    setPresence('unknown');
    void ipc()
      .secrets.exists({ ref: value })
      .then((result) => {
        if (cancelled) return;
        // A failed probe is treated as present: it must never toast, and must never block
        // editing by claiming a ref is missing when the check itself simply failed.
        setPresence(result.ok && !result.value.exists ? 'missing' : 'present');
      });
    return () => {
      cancelled = true;
    };
  }, [value, disabled]);

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

  const missing = value !== undefined && presence === 'missing';

  return (
    <div className="flex items-center gap-2">
      <span
        aria-label={label}
        className="flex-1 rounded border border-hairline-strong bg-surface-base px-2 py-1.5 text-sm text-fg-subtle"
      >
        {missing ? (
          <span data-testid="secret-missing">Not on this machine</span>
        ) : value !== undefined ? (
          '••••••••'
        ) : (
          'Not set'
        )}
      </span>
      <Button disabled={disabled} onClick={() => setEditing(true)}>
        {missing ? 'Enter…' : value !== undefined ? 'Replace…' : 'Set…'}
      </Button>
      {value !== undefined && (
        <Button disabled={disabled} onClick={clear}>
          Clear
        </Button>
      )}
    </div>
  );
}
