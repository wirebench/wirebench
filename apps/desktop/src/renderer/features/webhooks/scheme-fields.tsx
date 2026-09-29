/**
 * The fields of one signature scheme, shared by the catch URL section and the signing controls.
 *
 * The tolerance box keeps what was typed: text that is not a whole number reaches `onChange` as
 * `NaN`, so `schemeProblemOf` reports it and the box is not snapped to a number the user never typed.
 */
import { useState } from 'react';
import { INPUT_CLASS } from '../team/roles.js';
import type { SignatureSchemeWire } from '../../../shared/wire-types.js';

const LABEL_CLASS = 'mt-2 block text-xs text-fg-subtle';

/** A typed tolerance as seconds; `NaN` for anything but a whole number. */
const toleranceOf = (text: string): number => (/^\d+$/.test(text.trim()) ? Number(text.trim()) : Number.NaN);

export function SchemeFields({
  scheme,
  onChange,
  disabled,
  prefix,
  describedBy,
}: {
  readonly scheme: SignatureSchemeWire;
  readonly onChange: (next: SignatureSchemeWire) => void;
  readonly disabled: boolean;
  /** Test-id and element-id prefix, e.g. `catch-url-signature`. */
  readonly prefix: string;
  /** Ids of elements that describe the fields (e.g. why they are disabled). */
  readonly describedBy?: string | undefined;
}) {
  const committed = scheme.kind === 'hmac' ? undefined : scheme.toleranceSec;
  const [toleranceDraft, setToleranceDraft] = useState({ text: String(committed ?? ''), value: committed });
  // A tolerance set from outside (another scheme kind, a reset) replaces the typed text; the NaN a
  // bad entry sent up comes back as the same value and leaves the text alone.
  if (!Object.is(toleranceDraft.value, committed)) {
    setToleranceDraft({ text: String(committed ?? ''), value: committed });
  }
  const tolerance =
    scheme.kind === 'hmac' ? null : (
      <div className="w-32">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-tolerance`}>
          Tolerance (s)
        </label>
        <input
          id={`${prefix}-tolerance`}
          data-testid={`${prefix}-tolerance`}
          inputMode="numeric"
          disabled={disabled}
          aria-describedby={describedBy}
          value={toleranceDraft.text}
          onChange={(event) => {
            const toleranceSec = toleranceOf(event.target.value);
            setToleranceDraft({ text: event.target.value, value: toleranceSec });
            onChange({ ...scheme, toleranceSec });
          }}
          className={INPUT_CLASS}
        />
      </div>
    );
  const header =
    scheme.kind === 'standard' ? null : (
      <div className="min-w-0 flex-1">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-header`}>
          Header
        </label>
        <input
          id={`${prefix}-header`}
          data-testid={`${prefix}-header`}
          disabled={disabled}
          aria-describedby={describedBy}
          value={scheme.header}
          onChange={(event) => onChange({ ...scheme, header: event.target.value })}
          className={INPUT_CLASS}
        />
      </div>
    );
  if (scheme.kind !== 'hmac') {
    return (
      <div className="flex gap-3">
        {header}
        {tolerance}
      </div>
    );
  }
  return (
    <div className="flex flex-wrap gap-3">
      <div className="w-28">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-algorithm`}>
          Algorithm
        </label>
        <select
          id={`${prefix}-algorithm`}
          data-testid={`${prefix}-algorithm`}
          disabled={disabled}
          aria-describedby={describedBy}
          value={scheme.algorithm}
          onChange={(event) => onChange({ ...scheme, algorithm: event.target.value as typeof scheme.algorithm })}
          className={INPUT_CLASS}
        >
          <option value="sha1">SHA-1</option>
          <option value="sha256">SHA-256</option>
          <option value="sha512">SHA-512</option>
        </select>
      </div>
      <div className="w-24">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-encoding`}>
          Encoding
        </label>
        <select
          id={`${prefix}-encoding`}
          data-testid={`${prefix}-encoding`}
          disabled={disabled}
          aria-describedby={describedBy}
          value={scheme.encoding}
          onChange={(event) => onChange({ ...scheme, encoding: event.target.value as typeof scheme.encoding })}
          className={INPUT_CLASS}
        >
          <option value="hex">hex</option>
          <option value="base64">base64</option>
        </select>
      </div>
      {header}
      <div className="w-28">
        <label className={LABEL_CLASS} htmlFor={`${prefix}-prefix`}>
          Prefix
        </label>
        <input
          id={`${prefix}-prefix`}
          data-testid={`${prefix}-prefix`}
          placeholder="None"
          disabled={disabled}
          aria-describedby={describedBy}
          value={scheme.prefix ?? ''}
          onChange={(event) => {
            const { kind, algorithm, encoding, header } = scheme;
            const base = { kind, algorithm, encoding, header };
            onChange(event.target.value === '' ? base : { ...base, prefix: event.target.value });
          }}
          className={INPUT_CLASS}
        />
      </div>
    </div>
  );
}
