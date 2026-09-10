/**
 * The leaf editors of the Form view: one control per `FormType.base`, plus the
 * small read-only badges (required/optional, occurrence, `xsi:type`) and the
 * muted facet hints that stand beside them.
 *
 * Every control is uncontrolled-with-a-draft: it keeps what the user is typing
 * locally and reports it upward on every keystroke, so the request pane can
 * splice the value straight into the envelope text without a round trip.
 * Nothing here validates — Task 42 owns validation; a hint is only ever a hint.
 */

import type { FormNodeWire, FormTypeWire } from '../../../../shared/wire-types.js';

/** `?` is the sample generator's placeholder: it reads as "nothing here yet". */
export const PLACEHOLDER = '?';

/** True when a node's value is empty for the purposes of the "Non-empty" view type. */
export function isEmptyValue(value: string | undefined): boolean {
  return value === undefined || value === '' || value === PLACEHOLDER;
}

/** The HTML `input` type that best fits a schema base type. */
function inputTypeFor(base: FormTypeWire['base']): string {
  switch (base) {
    case 'integer':
    case 'number':
      return 'number';
    case 'date':
      return 'date';
    case 'time':
      return 'time';
    case 'dateTime':
      return 'datetime-local';
    default:
      return 'text';
  }
}

/** The facet hints shown under a field, e.g. `pattern [A-Z]{5} · 1 … 99`. */
export function hintFor(type: FormTypeWire | undefined): string | undefined {
  if (type === undefined) {
    return undefined;
  }
  const parts: string[] = [];
  if (type.pattern !== undefined) {
    parts.push(`pattern ${type.pattern}`);
  }
  if (type.min !== undefined || type.max !== undefined) {
    parts.push(`${type.min ?? '…'} … ${type.max ?? '…'}`);
  }
  return parts.length === 0 ? undefined : parts.join(' · ');
}

export interface FieldEditorProps {
  readonly node: FormNodeWire;
  /** Reported on every keystroke; the caller decides whether it is a text splice or a structural edit. */
  readonly onChange: (value: string) => void;
  readonly disabled?: boolean;
}

/**
 * The editor for one leaf. Enum types get a `<select>` with a free-text escape
 * (a schema's enumeration is often incomplete in practice, and a property
 * expansion like `${#Project#code}` is never one of its values); date and time
 * types get the native picker with an ISO text fallback for the same reason.
 */
export function FieldEditor({ node, onChange, disabled = false }: FieldEditorProps) {
  const value = node.value ?? '';
  const label = `${node.label} value`;
  const readOnly = disabled || node.fixed !== undefined;

  if (node.type?.base === 'boolean') {
    return (
      <input
        type="checkbox"
        aria-label={label}
        disabled={readOnly}
        checked={value === 'true' || value === '1'}
        onChange={(event) => onChange(event.target.checked ? 'true' : 'false')}
        className="h-4 w-4 accent-accent"
      />
    );
  }

  const enumValues = node.type?.enum;
  if (enumValues !== undefined && enumValues.length > 0) {
    const known = enumValues.includes(value);
    return (
      <div className="flex min-w-0 flex-1 items-center gap-1">
        <select
          aria-label={label}
          disabled={readOnly}
          value={known ? value : ''}
          onChange={(event) => onChange(event.target.value)}
          className="min-w-0 flex-1 rounded-sm border border-hairline bg-surface-base px-1 py-0.5 text-sm text-fg-default"
        >
          <option value="">(other…)</option>
          {enumValues.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {!known && (
          <input
            type="text"
            aria-label={`${node.label} custom value`}
            disabled={readOnly}
            value={value}
            onChange={(event) => onChange(event.target.value)}
            className="min-w-0 flex-1 rounded-sm border border-hairline bg-surface-base px-1 py-0.5 text-sm text-fg-default"
          />
        )}
      </div>
    );
  }

  const base = node.type?.base ?? 'string';
  const inputType = inputTypeFor(base);
  // A date/time control cannot hold `?` or a `${…}` expansion, so it degrades to
  // plain text the moment the value is not a lexical date — never losing what
  // the user (or the sample generator) already wrote.
  const isTemporal = inputType === 'date' || inputType === 'time' || inputType === 'datetime-local';
  const temporalOk = isTemporal && /^\d{4}-\d{2}|^\d{2}:\d{2}/.test(value);
  return (
    <input
      type={isTemporal && !temporalOk ? 'text' : inputType}
      aria-label={label}
      disabled={readOnly}
      value={value}
      {...(inputType === 'number' && base === 'integer' ? { step: 1 } : {})}
      onChange={(event) => onChange(event.target.value)}
      className="min-w-0 flex-1 rounded-sm border border-hairline bg-surface-base px-1 py-0.5 text-sm text-fg-default"
    />
  );
}

/** The read-only badges that describe a node's cardinality and dynamic type. */
export function NodeBadges({ node }: { readonly node: FormNodeWire }) {
  const occurrence =
    node.occurs.max === 'unbounded' || node.occurs.max > 1
      ? `${node.occurs.min}…${node.occurs.max === 'unbounded' ? '∞' : node.occurs.max}`
      : undefined;
  return (
    <span className="flex shrink-0 items-center gap-1 text-xs">
      {node.required ? (
        <span className="text-warning" title="Required">
          *
        </span>
      ) : (
        <span className="text-fg-faint" title="Optional">
          opt
        </span>
      )}
      {occurrence !== undefined && <span className="text-fg-faint">{occurrence}</span>}
      {node.nillable === true && <span className="text-fg-faint">nillable</span>}
      {node.xsiType !== undefined && (
        <span className="rounded-sm bg-surface-raised px-1 text-fg-subtle" title="xsi:type">
          {node.xsiType}
        </span>
      )}
    </span>
  );
}
