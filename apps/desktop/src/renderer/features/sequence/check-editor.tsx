/**
 * How an assertion checks what it found: exactly one of `equals`, `matches` or `exists`. Shared by
 * the `match` and `header` assertions and by a callback's header and body checks.
 */
import { CommitInput, SelectField } from './step-fields.js';

type Check = 'equals' | 'matches' | 'exists' | 'absent';

const CHECKS: readonly { value: Check; label: string }[] = [
  { value: 'equals', label: 'equals' },
  { value: 'matches', label: 'matches' },
  { value: 'exists', label: 'is present' },
  { value: 'absent', label: 'is absent' },
];

/** The three check fields, as `CheckEditor` reports them. */
export interface CheckFields {
  equals?: string;
  matches?: string;
  exists?: boolean;
}

function checkOf(holder: CheckEditorProps['value']): Check {
  if (holder.matches !== undefined) return 'matches';
  if (holder.exists !== undefined) return holder.exists ? 'exists' : 'absent';
  return 'equals';
}

/** The check fields for `check`, with `value` as the compared value where one is compared. */
function checkFields(check: Check, value: string): CheckFields {
  switch (check) {
    case 'equals':
      return { equals: value };
    case 'matches':
      return { matches: value === '' ? '.*' : value };
    case 'exists':
      return { exists: true };
    case 'absent':
      return { exists: false };
  }
}

export interface CheckEditorProps {
  /** Anything with the three check fields: a `match`/`header` assertion, or a callback header or body check. */
  readonly value: {
    readonly equals?: string | number | boolean | undefined;
    readonly matches?: string | undefined;
    readonly exists?: boolean | undefined;
  };
  readonly onChange: (fields: CheckFields) => void;
  /** `${testId}-check` on the select, `${testId}-value` on the input. */
  readonly testId?: string;
}

/** The check, and the value it compares with. */
export function CheckEditor({ value: holder, onChange, testId }: CheckEditorProps) {
  const check = checkOf(holder);
  const value = holder.matches ?? (holder.equals !== undefined ? String(holder.equals) : '');
  return (
    <>
      <SelectField
        label="Check"
        {...(testId !== undefined ? { testId: `${testId}-check` } : {})}
        value={check}
        options={CHECKS}
        onChange={(next) => onChange(checkFields(next, value))}
      />
      {(check === 'equals' || check === 'matches') && (
        <CommitInput
          label={check === 'equals' ? 'Expected value' : 'Pattern'}
          {...(testId !== undefined ? { testId: `${testId}-value` } : {})}
          monospace
          className="min-w-32 flex-1"
          value={value}
          onCommit={(next) => onChange(checkFields(check, next))}
        />
      )}
    </>
  );
}
