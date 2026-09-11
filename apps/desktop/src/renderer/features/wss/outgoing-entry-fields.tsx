/**
 * The per-kind field blocks for one WS-Security entry row: everything below the row header in
 * {@link EntryRow} of `outgoing-config-editor.tsx`. Split out because the parent file mixes
 * three unrelated concerns (the config list, one config's editor, one entry's fields); this file
 * owns only the third.
 */

import { SecretField } from '../../components/secret-field.js';
import type { WssEntryWire } from '../../../shared/wire-types.js';

type WssTimestampEntry = Extract<WssEntryWire, { kind: 'timestamp' }>;
type WssUsernameTokenEntry = Extract<WssEntryWire, { kind: 'username-token' }>;

/** Tailwind classes shared by every text/number/select field in the WS-Security editor. */
export const WSS_FIELD_CLASS =
  'w-full rounded border border-hairline bg-surface-sunken px-1 py-0.5 text-xs text-fg-default';

interface TimestampFieldsProps {
  readonly entry: WssTimestampEntry;
  readonly onChange: (entry: WssTimestampEntry) => void;
}

/** The `wsu:Timestamp` entry's fields: time-to-live and millisecond precision. */
export function TimestampFields({ entry, onChange }: TimestampFieldsProps) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Time to live (s)</span>
        <input
          type="number"
          min={0}
          aria-label="Time to live (seconds)"
          className={WSS_FIELD_CLASS}
          value={entry.timeToLiveSeconds}
          onChange={(event) => {
            onChange({ ...entry, timeToLiveSeconds: Math.max(0, Number(event.target.value) || 0) });
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.millisecondPrecision}
          onChange={(event) => {
            onChange({ ...entry, millisecondPrecision: event.target.checked });
          }}
        />
        Millisecond precision
      </label>
    </div>
  );
}

interface UsernameTokenFieldsProps {
  readonly entry: WssUsernameTokenEntry;
  readonly onChange: (entry: WssUsernameTokenEntry) => void;
}

/** The `wsse:UsernameToken` entry's fields: username, password type/secret, nonce/created. */
export function UsernameTokenFields({ entry, onChange }: UsernameTokenFieldsProps) {
  return (
    <div className="mt-1 flex flex-col gap-1">
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Username</span>
        <input
          aria-label="Username"
          className={WSS_FIELD_CLASS}
          value={entry.username}
          onChange={(event) => {
            onChange({ ...entry, username: event.target.value });
          }}
        />
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <span className="w-24 shrink-0">Password type</span>
        <select
          aria-label="Password type"
          className={WSS_FIELD_CLASS}
          value={entry.passwordType}
          onChange={(event) => {
            onChange({ ...entry, passwordType: event.target.value as 'text' | 'digest' | 'none' });
          }}
        >
          <option value="digest">Digest</option>
          <option value="text">Text</option>
          <option value="none">None</option>
        </select>
      </label>
      <div data-testid="wss-entry-password">
        <SecretField
          label="WS-Security password"
          value={entry.passwordRef}
          onChange={(ref) => {
            // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
            const { passwordRef: dropped, ...rest } = entry;
            onChange(ref === undefined ? rest : { ...rest, passwordRef: ref });
          }}
        />
      </div>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.addNonce}
          onChange={(event) => {
            onChange({ ...entry, addNonce: event.target.checked });
          }}
        />
        Add nonce
      </label>
      <label className="flex items-center gap-1 text-xs text-fg-subtle">
        <input
          type="checkbox"
          checked={entry.addCreated}
          onChange={(event) => {
            onChange({ ...entry, addCreated: event.target.checked });
          }}
        />
        Add created
      </label>
    </div>
  );
}
