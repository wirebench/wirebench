/** The fields of one signature scheme, shared by the catch URL section and the signing controls. */
import { INPUT_CLASS } from '../team/roles.js';
import type { SignatureSchemeWire } from '../../../shared/wire-types.js';

const LABEL_CLASS = 'mt-2 block text-xs text-fg-subtle';

export function SchemeFields({
  scheme,
  onChange,
  disabled,
  prefix,
}: {
  readonly scheme: SignatureSchemeWire;
  readonly onChange: (next: SignatureSchemeWire) => void;
  readonly disabled: boolean;
  /** Test-id and element-id prefix, e.g. `catch-url-signature`. */
  readonly prefix: string;
}) {
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
          value={String(scheme.toleranceSec)}
          onChange={(event) => onChange({ ...scheme, toleranceSec: Number(event.target.value) })}
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
