/**
 * The small controls a step's transfers and assertions are edited with. A text field commits on blur
 * or Enter, like every settings field in the app, so each committed change is one `update-sequence`,
 * validated by main against the same rules a sequence file is held to.
 */
import type { ReactNode } from 'react';

const FIELD =
  'h-row min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:ring-1 focus:ring-accent focus:outline-none';

export interface CommitInputProps {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly placeholder?: string;
  readonly monospace?: boolean;
  readonly testId?: string;
  readonly className?: string;
  /** The id of a `<datalist>` to suggest values from; free text stays allowed. */
  readonly list?: string;
}

/** A text field that reports its value when the user is done with it, not on every keystroke. */
export function CommitInput({
  label,
  value,
  onCommit,
  placeholder,
  monospace,
  testId,
  className = '',
  list,
}: CommitInputProps) {
  return (
    <input
      // Re-mounted when the stored value changes under it, so a refused edit snaps back.
      key={value}
      aria-label={label}
      data-testid={testId}
      list={list}
      defaultValue={value}
      placeholder={placeholder}
      className={`${FIELD} ${monospace === true ? 'font-mono' : ''} ${className}`}
      onBlur={(event) => {
        if (event.currentTarget.value !== value) {
          onCommit(event.currentTarget.value);
        }
      }}
      onKeyDown={(event) => {
        if (event.key === 'Enter' && event.currentTarget.value !== value) {
          onCommit(event.currentTarget.value);
        }
      }}
    />
  );
}

export interface SelectFieldProps<T extends string> {
  readonly label: string;
  readonly value: T;
  readonly options: readonly { readonly value: T; readonly label: string }[];
  readonly onChange: (value: T) => void;
  readonly testId?: string;
}

/** A plain `<select>`, the app's pattern for a short fixed choice. */
export function SelectField<T extends string>({ label, value, options, onChange, testId }: SelectFieldProps<T>) {
  return (
    <select
      aria-label={label}
      data-testid={testId}
      value={value}
      className={`${FIELD} shrink-0`}
      onChange={(event) => onChange(event.currentTarget.value as T)}
    >
      {options.map((option) => (
        <option key={option.value} value={option.value}>
          {option.label}
        </option>
      ))}
    </select>
  );
}

export interface CheckFieldProps {
  readonly label: string;
  readonly checked: boolean;
  readonly onChange: (checked: boolean) => void;
  readonly testId?: string;
}

/** A labelled checkbox. */
export function CheckField({ label, checked, onChange, testId }: CheckFieldProps) {
  return (
    <label className="flex shrink-0 items-center gap-1 text-sm text-fg-muted">
      <input
        type="checkbox"
        data-testid={testId}
        checked={checked}
        onChange={(event) => onChange(event.currentTarget.checked)}
      />
      {label}
    </label>
  );
}

/** One editable row: its fields, then a Remove button. */
export function FieldRow({
  children,
  onRemove,
  removeLabel,
  testId,
}: {
  readonly children: ReactNode;
  readonly onRemove: () => void;
  readonly removeLabel: string;
  readonly testId?: string;
}) {
  return (
    <li data-testid={testId} className="flex flex-wrap items-center gap-2 py-1">
      {children}
      <button
        type="button"
        aria-label={removeLabel}
        className="ml-auto rounded px-1.5 text-sm text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
        onClick={onRemove}
      >
        ×
      </button>
    </li>
  );
}
