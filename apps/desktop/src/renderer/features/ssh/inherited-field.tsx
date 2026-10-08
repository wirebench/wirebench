import { useId } from 'react';

export const INPUT_CLASS =
  'rounded border border-hairline-strong bg-surface-base px-2 py-1 text-sm text-fg-default outline-none focus:ring-1 focus:ring-accent disabled:text-fg-subtle';

export type Provenance<T> = { value: T | undefined; from: 'host' | 'default' | { group: string } };

export interface InheritedFieldProps<T extends string | number> {
  readonly label: string;
  /** What the field resolves to without an override here, and where that came from. */
  readonly provenance: Provenance<T>;
  /** This entry's own value; `undefined` means it inherits. */
  readonly override: T | undefined;
  readonly onChange: (next: T | undefined) => void;
  readonly type?: 'text' | 'number';
}

/**
 * One inheritable setting: shows the inherited value greyed with its source ("from prod"); the Override
 * switch makes the field editable, starting from the inherited value, and switching it off inherits again.
 */
export function InheritedField<T extends string | number>({
  label,
  provenance,
  override,
  onChange,
  type = 'text',
}: InheritedFieldProps<T>) {
  const id = useId();
  const overridden = override !== undefined;
  const source =
    typeof provenance.from === 'object'
      ? `from ${provenance.from.group}`
      : provenance.from === 'default'
        ? 'default'
        : undefined;
  const shown = overridden ? override : provenance.value;
  return (
    <div className="flex items-end gap-2">
      <label htmlFor={id} className="flex flex-1 flex-col gap-1 text-xs">
        <span className="text-fg-subtle">{label}</span>
        <input
          id={id}
          type={type}
          disabled={!overridden}
          className={INPUT_CLASS}
          value={shown === undefined ? '' : String(shown)}
          onChange={(e) => {
            onChange((type === 'number' ? Number(e.target.value) : e.target.value) as T);
          }}
        />
      </label>
      {source !== undefined && !overridden ? <span className="pb-1.5 text-xs text-fg-subtle">{source}</span> : null}
      <button
        type="button"
        role="switch"
        aria-checked={overridden}
        aria-label={`Override ${label}`}
        className={`mb-1 inline-flex h-4 w-7 shrink-0 items-center rounded-full border border-hairline-strong px-0.5 transition-colors focus-visible:ring-1 focus-visible:ring-accent focus-visible:outline-none ${overridden ? 'justify-end bg-accent' : 'justify-start bg-surface-base'}`}
        onClick={() => {
          onChange(overridden ? undefined : (provenance.value ?? ((type === 'number' ? 0 : '') as T)));
        }}
      >
        <span className="size-2.5 rounded-full bg-fg-default" />
      </button>
    </div>
  );
}
