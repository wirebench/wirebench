import { useId, useState } from 'react';

export const INPUT_CLASS =
  'rounded border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:text-fg-subtle';

export type Provenance<T> = { value: T | undefined; from: 'host' | 'default' | { group: string } };

/** Where a value comes from, as a row shows it: "22 · default", "deploy · from Production"; nothing when unset. */
export function sourceText<T>(provenance: Provenance<T>, show: (value: T) => string = String): string | undefined {
  if (provenance.value === undefined) return undefined;
  const value = show(provenance.value);
  if (typeof provenance.from === 'object') return `${value} · from ${provenance.from.group}`;
  return provenance.from === 'default' ? `${value} · default` : undefined;
}

/** Whether a group (or Preferences) supplies the value: only then is there something to inherit or override. */
function fromGroup<T>(provenance: Provenance<T>): boolean {
  return typeof provenance.from === 'object' && provenance.value !== undefined;
}

export interface InheritedFieldProps<T extends string | number> {
  readonly label: string;
  /** What the field resolves to without an override here, and where that came from. */
  readonly provenance: Provenance<T>;
  /** This entry's own value; `undefined` means it inherits. */
  readonly override: T | undefined;
  readonly onChange: (next: T | undefined) => void;
  readonly type?: 'text' | 'number';
}

const SWITCH_CLASS =
  'inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-hairline-strong px-0.5 transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none disabled:opacity-50';

/**
 * One inheritable setting. When a group supplies it, the field shows that value greyed with its source
 * ("deploy · from Production") and one Override switch makes it editable here. Otherwise it is a plain field:
 * left empty it takes the default, which shows as its placeholder and source ("22 · default").
 */
export function InheritedField<T extends string | number>({
  label,
  provenance,
  override,
  onChange,
  type = 'text',
}: InheritedFieldProps<T>) {
  const id = useId();
  // A cleared field reports `undefined` (inherit) but stays editable until the switch is turned off.
  const [editing, setEditing] = useState(false);
  const inheritable = fromGroup(provenance);
  const overridden = !inheritable || override !== undefined || editing;
  const source = sourceText(provenance);
  const shown = override !== undefined ? override : overridden ? undefined : provenance.value;
  return (
    <div className="flex flex-col gap-1 text-xs">
      <div className="flex gap-2">
        <label htmlFor={id} className="text-fg-subtle">
          {label}
        </label>
        {source !== undefined && override === undefined && !editing ? (
          <span className="truncate text-fg-faint">{source}</span>
        ) : null}
      </div>
      <div className="flex items-center gap-2">
        <input
          id={id}
          type={type}
          disabled={!overridden}
          className={`${INPUT_CLASS} min-w-0 flex-1`}
          placeholder={!inheritable && provenance.value !== undefined ? String(provenance.value) : undefined}
          value={shown === undefined ? '' : String(shown)}
          onChange={(e) => {
            if (e.target.value === '') {
              setEditing(true);
              onChange(undefined);
              return;
            }
            onChange((type === 'number' ? Number(e.target.value) : e.target.value) as T);
          }}
        />
        {inheritable && (
          <button
            type="button"
            role="switch"
            aria-checked={overridden}
            aria-label={`Override ${label}`}
            className={`${SWITCH_CLASS} ${overridden ? 'justify-end bg-accent' : 'justify-start bg-surface-base'}`}
            onClick={() => {
              setEditing(!overridden);
              onChange(overridden ? undefined : provenance.value);
            }}
          >
            <span className="size-2.5 rounded-full bg-fg-default" />
          </button>
        )}
      </div>
    </div>
  );
}

export interface InheritedSwitchProps {
  readonly label: string;
  /** What the setting resolves to without an override here, and where that came from. */
  readonly provenance: Provenance<boolean>;
  /** This entry's own value; `undefined` means it inherits. */
  readonly override: boolean | undefined;
  readonly onChange: (next: boolean | undefined) => void;
}

/**
 * {@link InheritedField} for an on/off setting: one switch for the value, with its source as text while it
 * inherits ("on · from Production"). Flipping it sets the value here; when a group supplies the value,
 * Inherit puts it back, and with nothing to inherit, flipping back to the default writes nothing.
 */
export function InheritedSwitch({ label, provenance, override, onChange }: InheritedSwitchProps) {
  const inheritable = fromGroup(provenance);
  const fallback = provenance.value ?? false;
  const on = override ?? fallback;
  const source = override === undefined ? sourceText(provenance, (v) => (v ? 'on' : 'off')) : undefined;
  return (
    <div className="flex items-center gap-2 text-xs">
      <span className="flex-1 text-fg-subtle">{label}</span>
      {source !== undefined ? <span className="text-fg-faint">{source}</span> : null}
      {inheritable && override !== undefined ? (
        <button
          type="button"
          aria-label={`Inherit ${label}`}
          className="rounded px-1 text-fg-subtle hover:text-fg-default focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none"
          onClick={() => {
            onChange(undefined);
          }}
        >
          Inherit
        </button>
      ) : null}
      <button
        type="button"
        role="switch"
        aria-checked={on}
        aria-label={label}
        className={`${SWITCH_CLASS} ${on ? 'justify-end bg-accent' : 'justify-start bg-surface-base'}`}
        onClick={() => {
          onChange(!inheritable && !on === fallback ? undefined : !on);
        }}
      >
        <span className="size-2.5 rounded-full bg-fg-default" />
      </button>
    </div>
  );
}
