/**
 * A step's branches (#347): after the step runs, the first rule whose condition holds decides where the
 * run goes — this step again, another step, or past the next one. A condition is one of the step checks,
 * or the step's outcome. Every go-to and repeat has a maximum, so no loop runs unbounded; main holds an
 * edit to the file's limits and refuses one beyond them.
 */
import type { BranchConditionWire, BranchRuleWire, SequenceStepWire } from '@shared/wire-base.js';
import { CheckEditor } from './check-editor.js';
import { CheckField, CommitInput, FieldRow, SelectField } from './step-fields.js';

type ConditionType = BranchConditionWire['type'];
type Action = BranchRuleWire['then'];
type Outcome = 'passed' | 'failed' | 'errored';

const CONDITIONS: readonly { value: ConditionType; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'header', label: 'Header' },
  { value: 'match', label: 'Body matches' },
  { value: 'soap-fault', label: 'SOAP fault' },
  { value: 'outcome', label: 'Step outcome' },
];

const ACTIONS: readonly { value: Action; label: string }[] = [
  { value: 'repeat', label: 'Repeat this step' },
  { value: 'goto', label: 'Go to step' },
  { value: 'skip-next', label: 'Skip the next step' },
];

const OUTCOMES: readonly { value: Outcome; label: string }[] = [
  { value: 'errored', label: 'errored' },
  { value: 'failed', label: 'failed' },
  { value: 'passed', label: 'passed' },
];

const LANGUAGES = [
  { value: 'jsonpath', label: 'JSONPath' },
  { value: 'xpath', label: 'XPath' },
  { value: 'xquery', label: 'XQuery' },
] as const;

/** A maximum a new loop starts with. */
const DEFAULT_MAX = 5;

/** A fresh condition of `type`, keeping `not`. */
function conditionOf(type: ConditionType, not: boolean): BranchConditionWire {
  const inverted = not ? { not: true } : {};
  switch (type) {
    case 'status':
      return { type, equals: 503, ...inverted };
    case 'header':
      return { type, header: 'Retry-After', exists: true, ...inverted };
    case 'match':
      return { type, language: 'jsonpath', expression: '$.status', equals: 'done', ...inverted };
    case 'soap-fault':
      return { type, expect: 'present', ...inverted };
    case 'outcome':
      return { type, equals: 'errored', ...inverted };
  }
}

/** `rule` doing `then` instead, keeping its condition and, for a loop, its max and delay. */
function withAction(
  rule: BranchRuleWire,
  then: Action,
  steps: readonly SequenceStepWire[],
  self: string,
): BranchRuleWire {
  if (then === 'skip-next') {
    return { when: rule.when, then };
  }
  const max = rule.then === 'skip-next' ? DEFAULT_MAX : rule.max;
  const delay = rule.then !== 'skip-next' && rule.delayMs !== undefined ? { delayMs: rule.delayMs } : {};
  if (then === 'repeat') {
    return { when: rule.when, then, max, ...delay };
  }
  const step = steps.find((candidate) => candidate.id !== self)?.id ?? self;
  return { when: rule.when, then, step, max, ...delay };
}

/** A status list as typed: numbers stay numbers, `5xx` and gRPC names stay text. */
function parseStatus(text: string): number | string | (number | string)[] {
  const values = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return values.length === 1 ? values[0]! : values;
}

function notOf(when: BranchConditionWire): { not?: boolean } {
  return when.not === true ? { not: true } : {};
}

/** The fields of one condition. */
function ConditionFields({
  when,
  onChange,
}: {
  readonly when: BranchConditionWire;
  readonly onChange: (when: BranchConditionWire) => void;
}) {
  switch (when.type) {
    case 'status':
      return (
        <CommitInput
          label="Status"
          monospace
          className="w-28"
          placeholder="503, 5xx"
          value={Array.isArray(when.equals) ? when.equals.join(', ') : String(when.equals)}
          onCommit={(text) => onChange({ ...when, equals: parseStatus(text) })}
        />
      );
    case 'header':
      return (
        <>
          <CommitInput
            label="Header name"
            className="w-36"
            value={when.header}
            onCommit={(header) => onChange({ ...when, header })}
          />
          <CheckEditor
            value={when}
            onChange={(check) => onChange({ type: 'header', header: when.header, ...check, ...notOf(when) })}
          />
        </>
      );
    case 'match':
      return (
        <>
          <SelectField
            label="Language"
            value={when.language}
            options={LANGUAGES}
            onChange={(language) => onChange({ ...when, language })}
          />
          <CommitInput
            label="Expression"
            monospace
            className="min-w-32 flex-1"
            value={when.expression}
            onCommit={(expression) => onChange({ ...when, expression })}
          />
          <CheckEditor
            value={when}
            onChange={(check) =>
              onChange({
                type: 'match',
                language: when.language,
                expression: when.expression,
                ...(when.namespaces !== undefined ? { namespaces: when.namespaces } : {}),
                ...check,
                ...notOf(when),
              })
            }
          />
        </>
      );
    case 'soap-fault':
      return (
        <SelectField
          label="SOAP fault"
          value={when.expect}
          options={[
            { value: 'present', label: 'is present' },
            { value: 'none', label: 'is absent' },
          ]}
          onChange={(expect) => onChange({ ...when, expect })}
        />
      );
    case 'outcome':
      return (
        <SelectField
          label="Outcome"
          value={Array.isArray(when.equals) ? (when.equals[0] ?? 'errored') : when.equals}
          options={OUTCOMES}
          onChange={(equals) => onChange({ ...when, equals })}
        />
      );
  }
}

/** A count as typed, or `fallback` when the text is not a whole number. */
function wholeNumber(text: string, fallback: number): number {
  return /^\d+$/.test(text.trim()) ? Number(text.trim()) : fallback;
}

export interface BranchListProps {
  readonly branches: readonly BranchRuleWire[];
  /** Every step of the sequence, for a go-to's target. */
  readonly steps: readonly SequenceStepWire[];
  /** The id of the step these branches belong to. */
  readonly stepId: string;
  /** What a step is called where a go-to names it: its own name, or its request's. */
  readonly labelOf: (step: SequenceStepWire) => string;
  readonly onChange: (branches: BranchRuleWire[]) => void;
}

export function BranchList({ branches, steps, stepId, labelOf, onChange }: BranchListProps) {
  const replace = (index: number, next: BranchRuleWire): void =>
    onChange(branches.map((rule, i) => (i === index ? next : rule)));
  const targets = steps.map((step, index) => ({
    value: step.id,
    label: `${index + 1}. ${labelOf(step)}`,
  }));

  return (
    <div data-testid="sequence-branches">
      {branches.length === 0 ? (
        <p className="py-1 text-sm text-fg-subtle">
          The run goes on to the next step. Add a branch to repeat this step, go to another, or skip the next.
        </p>
      ) : (
        <ul>
          {branches.map((rule, index) => (
            <FieldRow
              key={index}
              testId="sequence-branch-row"
              removeLabel={`Remove branch ${index + 1}`}
              onRemove={() => onChange(branches.filter((_, i) => i !== index))}
            >
              <span className="text-sm text-fg-muted">If</span>
              <CheckField
                label="not"
                checked={rule.when.not === true}
                onChange={(not) => {
                  // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
                  const { not: _not, ...when } = rule.when;
                  replace(index, { ...rule, when: not ? { ...when, not: true } : when });
                }}
              />
              <SelectField
                label="Condition"
                testId="sequence-branch-condition"
                value={rule.when.type}
                options={CONDITIONS}
                onChange={(type) => replace(index, { ...rule, when: conditionOf(type, rule.when.not === true) })}
              />
              <ConditionFields when={rule.when} onChange={(when) => replace(index, { ...rule, when })} />
              <span className="text-sm text-fg-muted">then</span>
              <SelectField
                label="Action"
                testId="sequence-branch-action"
                value={rule.then}
                options={ACTIONS}
                onChange={(then) => replace(index, withAction(rule, then, steps, stepId))}
              />
              {rule.then === 'goto' && (
                <SelectField
                  label="Target step"
                  testId="sequence-branch-target"
                  value={rule.step}
                  options={targets}
                  onChange={(step) => replace(index, { ...rule, step })}
                />
              )}
              {rule.then !== 'skip-next' && (
                <>
                  <CommitInput
                    label="At most"
                    testId="sequence-branch-max"
                    className="w-16"
                    value={String(rule.max)}
                    onCommit={(text) => replace(index, { ...rule, max: wholeNumber(text, rule.max) })}
                  />
                  <span className="text-sm text-fg-muted">times, waiting</span>
                  <CommitInput
                    label="Wait (ms)"
                    className="w-20"
                    placeholder="0"
                    value={rule.delayMs !== undefined ? String(rule.delayMs) : ''}
                    onCommit={(text) => {
                      // eslint-disable-next-line @typescript-eslint/no-unused-vars -- destructured only to omit it
                      const { delayMs: _delay, ...rest } = rule;
                      replace(index, text.trim() === '' ? rest : { ...rest, delayMs: wholeNumber(text, 0) });
                    }}
                  />
                  <span className="text-sm text-fg-muted">ms</span>
                </>
              )}
            </FieldRow>
          ))}
        </ul>
      )}
      <button
        type="button"
        data-testid="sequence-add-branch"
        className="mt-1 text-sm text-accent hover:underline"
        onClick={() =>
          onChange([...branches, { when: { type: 'status', equals: 503 }, then: 'repeat', max: DEFAULT_MAX }])
        }
      >
        Add branch
      </button>
    </div>
  );
}
