/**
 * The values a snippet's declared variables take for one run: prefilled with the last values used here,
 * else the defaults. A value that would type an extra line or a control key is refused here, before main is
 * asked (main refuses it too).
 */
import { useId } from 'react';
import type { SnippetVariableWire } from '@shared/snippets-wire.js';
import { INPUT_CLASS } from '../inherited-field.js';
import { invalidValue } from './run.js';

export const INVALID_VALUE_MESSAGE = 'A value cannot hold a line break or a control key';

/** The form's first values: the last ones used for a variable still declared, else its default, else empty. */
export function initialValues(
  variables: readonly SnippetVariableWire[],
  last: Readonly<Record<string, string>>,
): Record<string, string> {
  return Object.fromEntries(variables.map((v) => [v.name, last[v.name] ?? v.default ?? '']));
}

/** Whether any value would be refused. */
export function anyInvalid(values: Readonly<Record<string, string>>): boolean {
  return Object.values(values).some(invalidValue);
}

/** The variables whose value is empty: the script would run with nothing in their place. */
export function emptyVariables(
  variables: readonly SnippetVariableWire[],
  values: Readonly<Record<string, string>>,
): SnippetVariableWire[] {
  return variables.filter((v) => (values[v.name] ?? '') === '');
}

export function VariablesForm(props: {
  readonly variables: readonly SnippetVariableWire[];
  readonly values: Readonly<Record<string, string>>;
  readonly onChange: (name: string, value: string) => void;
}) {
  const base = useId();
  if (props.variables.length === 0) return null;
  return (
    <fieldset className="flex flex-col gap-2">
      <legend className="mb-1 text-xs font-medium text-fg-muted">Variables</legend>
      {props.variables.map((v, index) => {
        const id = `${base}-${String(index)}`;
        const value = props.values[v.name] ?? '';
        const invalid = invalidValue(value);
        return (
          // The hints sit outside the <label>, so the field's name stays the variable's.
          <div key={v.name} className="flex flex-col gap-1 text-xs text-fg-subtle">
            <label htmlFor={id}>{v.label ?? v.name}</label>
            <input
              id={id}
              className={INPUT_CLASS}
              value={value}
              placeholder={v.default}
              aria-invalid={invalid ? 'true' : undefined}
              onChange={(e) => {
                props.onChange(v.name, e.target.value);
              }}
            />
            {invalid && (
              <span role="alert" className="text-status-danger">
                {INVALID_VALUE_MESSAGE}
              </span>
            )}
            {value === '' && (
              <span data-testid="snippet-variable-empty" className="text-status-warning">
                Empty: the script gets nothing here
              </span>
            )}
          </div>
        );
      })}
    </fieldset>
  );
}
