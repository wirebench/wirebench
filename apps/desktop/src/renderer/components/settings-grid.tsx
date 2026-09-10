import { useEffect, useId, useState } from 'react';

/**
 * The two-column "name | editor" grid every settings surface uses — the Details panel's
 * request/interface/endpoint properties and each section of the Preferences editor.
 *
 * Text and number fields commit on blur or Enter (Escape reverts), so a keystroke is never a
 * mutation; checkboxes and selects commit immediately, because there is nothing to revert to.
 * Every row is a real `<label>` bound to its control, which is what makes the grid keyboard-
 * and screen-reader-navigable without any extra ARIA.
 */

const CONTROL =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent disabled:opacity-60';

export interface SettingsGroupProps {
  readonly title?: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

/** A titled group of rows, with an optional explanatory hint under the heading. */
export function SettingsGroup({ title, hint, children }: SettingsGroupProps) {
  return (
    <section className="mb-4">
      {title !== undefined && (
        <h3 className="mb-1 text-xs font-medium tracking-wider text-fg-subtle uppercase">{title}</h3>
      )}
      {hint !== undefined && <p className="mb-2 text-sm text-fg-subtle">{hint}</p>}
      <div className="flex flex-col">{children}</div>
    </section>
  );
}

interface RowProps {
  readonly label: string;
  readonly htmlFor: string;
  readonly hint?: string;
  readonly children: React.ReactNode;
}

function Row({ label, htmlFor, hint, children }: RowProps) {
  return (
    <div className="flex items-center gap-2 py-0.5">
      <label htmlFor={htmlFor} className="w-44 shrink-0 truncate text-sm text-fg-muted" title={hint ?? label}>
        {label}
      </label>
      <div className="min-w-0 flex-1">{children}</div>
    </div>
  );
}

export interface TextSettingProps {
  readonly label: string;
  readonly value: string;
  readonly onCommit: (value: string) => void;
  readonly placeholder?: string;
  readonly readOnly?: boolean;
  readonly hint?: string;
  readonly monospace?: boolean;
  readonly testId?: string;
}

/** A free-text row. Commits on blur or Enter; Escape restores the last committed value. */
export function TextSetting({
  label,
  value,
  onCommit,
  placeholder,
  readOnly = false,
  hint,
  monospace = false,
  testId,
}: TextSettingProps) {
  const id = useId();
  const [draft, setDraft] = useState(value);
  useEffect(() => {
    setDraft(value);
  }, [value]);

  return (
    <Row label={label} htmlFor={id} {...(hint !== undefined ? { hint } : {})}>
      <input
        id={id}
        aria-label={label}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        readOnly={readOnly}
        className={`${CONTROL}${monospace ? ' font-mono' : ''}${readOnly ? ' text-fg-muted' : ''}`}
        value={draft}
        placeholder={placeholder ?? ''}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={() => {
          if (!readOnly && draft !== value) {
            onCommit(draft);
          }
        }}
        onKeyDown={(event) => {
          if (event.key === 'Enter' && !readOnly) {
            onCommit(draft);
          }
          if (event.key === 'Escape') {
            setDraft(value);
          }
        }}
      />
    </Row>
  );
}

export interface NumberSettingProps {
  readonly label: string;
  readonly value: number | undefined;
  /** `undefined` means "cleared" — the field was emptied, so the setting falls back to its default. */
  readonly onCommit: (value: number | undefined) => void;
  readonly placeholder?: string;
  readonly min?: number;
  readonly hint?: string;
  readonly testId?: string;
}

/**
 * A numeric row. An empty field commits `undefined` (inherit / no value); anything that does
 * not parse as a finite number is rejected and the field snaps back, rather than persisting a
 * `NaN` that would silently disable a timeout.
 */
export function NumberSetting({ label, value, onCommit, placeholder, min, hint, testId }: NumberSettingProps) {
  const id = useId();
  const asText = value === undefined ? '' : String(value);
  const [draft, setDraft] = useState(asText);
  useEffect(() => {
    setDraft(asText);
  }, [asText]);

  const commit = (): void => {
    const trimmed = draft.trim();
    if (trimmed.length === 0) {
      if (value !== undefined) {
        onCommit(undefined);
      }
      return;
    }
    const parsed = Number(trimmed);
    if (!Number.isFinite(parsed) || (min !== undefined && parsed < min)) {
      setDraft(asText);
      return;
    }
    if (parsed !== value) {
      onCommit(parsed);
    }
  };

  return (
    <Row label={label} htmlFor={id} {...(hint !== undefined ? { hint } : {})}>
      <input
        id={id}
        aria-label={label}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        inputMode="numeric"
        className={CONTROL}
        value={draft}
        placeholder={placeholder ?? ''}
        onChange={(event) => {
          setDraft(event.target.value);
        }}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            commit();
          }
          if (event.key === 'Escape') {
            setDraft(asText);
          }
        }}
      />
    </Row>
  );
}

export interface BooleanSettingProps {
  readonly label: string;
  readonly value: boolean;
  readonly onChange: (value: boolean) => void;
  readonly hint?: string;
  readonly disabled?: boolean;
  readonly testId?: string;
}

/** A checkbox row. Commits immediately — there is no half-typed state to protect. */
export function BooleanSetting({ label, value, onChange, hint, disabled = false, testId }: BooleanSettingProps) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id} {...(hint !== undefined ? { hint } : {})}>
      <input
        id={id}
        type="checkbox"
        aria-label={label}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        disabled={disabled}
        checked={value}
        onChange={(event) => {
          onChange(event.target.checked);
        }}
        className="h-4 w-4 accent-[var(--color-accent)]"
      />
    </Row>
  );
}

export interface EnumSettingOption {
  readonly value: string;
  readonly label: string;
}

export interface EnumSettingProps {
  readonly label: string;
  readonly value: string;
  readonly options: readonly EnumSettingOption[];
  readonly onChange: (value: string) => void;
  readonly hint?: string;
  readonly testId?: string;
}

/** A `<select>` row, for a closed set of values. */
export function EnumSetting({ label, value, options, onChange, hint, testId }: EnumSettingProps) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id} {...(hint !== undefined ? { hint } : {})}>
      <select
        id={id}
        aria-label={label}
        {...(testId !== undefined ? { 'data-testid': testId } : {})}
        className={CONTROL}
        value={value}
        onChange={(event) => {
          onChange(event.target.value);
        }}
      >
        {options.map((option) => (
          <option key={option.value} value={option.value}>
            {option.label}
          </option>
        ))}
      </select>
    </Row>
  );
}

export interface ReadOnlySettingProps {
  readonly label: string;
  readonly value: string;
  readonly hint?: string;
}

/** A row that only reports a value — an interface's WS-A version, a command's shortcut. */
export function ReadOnlySetting({ label, value, hint }: ReadOnlySettingProps) {
  const id = useId();
  return (
    <Row label={label} htmlFor={id} {...(hint !== undefined ? { hint } : {})}>
      <output id={id} className="block truncate py-1 text-sm text-fg-muted">
        {value}
      </output>
    </Row>
  );
}
