/**
 * Assertions in a table: a sequence step's own (every kind), or a request's own (the kinds its protocol can check).
 */
import type { StepAssertionWire } from '../../../shared/wire-types.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { CallbackFields } from '../sequence/callback-fields.js';
import { CALLBACK_BOUNDS } from '../sequence/callback-text.js';
import { CheckEditor } from '../sequence/check-editor.js';
import { CommitInput, FieldRow, SelectField } from '../sequence/step-fields.js';

export type AssertionKind = StepAssertionWire['type'];

const LABELS: Record<AssertionKind, string> = {
  status: 'Status',
  header: 'Header',
  match: 'Body matches',
  sla: 'Response time',
  'soap-fault': 'SOAP fault',
  schema: 'Schema',
  callback: 'Callback',
};

export const STEP_KINDS: readonly AssertionKind[] = [
  'status',
  'header',
  'match',
  'sla',
  'soap-fault',
  'schema',
  'callback',
];
export const SOAP_REQUEST_KINDS: readonly AssertionKind[] = [
  'status',
  'match',
  'sla',
  'soap-fault',
  'schema',
  'callback',
];
export const REQUEST_KINDS: readonly AssertionKind[] = ['status', 'match', 'sla', 'callback'];

const LANGUAGES = [
  { value: 'jsonpath', label: 'JSONPath' },
  { value: 'xpath', label: 'XPath' },
  { value: 'xquery', label: 'XQuery' },
] as const;

/** A new assertion of `kind`; a callback starts from the first catch URL the workspace knows. */
function defaultOf(kind: AssertionKind, catchUrls: readonly string[]): StepAssertionWire {
  switch (kind) {
    case 'status':
      return { type: 'status', equals: 200 };
    case 'header':
      return { type: 'header', header: 'Content-Type', exists: true };
    case 'match':
      return { type: 'match', language: 'jsonpath', expression: '$', exists: true };
    case 'sla':
      return { type: 'sla', maxMs: 1000 };
    case 'soap-fault':
      return { type: 'soap-fault', expect: 'none' };
    case 'schema':
      return { type: 'schema' };
    case 'callback':
      return {
        type: 'callback',
        catchUrl: catchUrls[0] ?? 'catch-url',
        withinMs: CALLBACK_BOUNDS.defaultWithinMs,
        match: { method: 'POST' },
        expect: [{ body: { language: 'jsonpath', path: '$', exists: true } }],
      };
  }
}

/** `assertion` with none of its check fields, so exactly one can be set again. */
function withoutCheck(assertion: Extract<StepAssertionWire, { type: 'match' | 'header' }>): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...assertion };
  delete copy['equals'];
  delete copy['matches'];
  delete copy['exists'];
  return copy;
}

/** `201` or `2xx, 304` as the status assertion's `equals`. */
function parseStatuses(text: string): number | string | (number | string)[] {
  const parts = text
    .split(',')
    .map((part) => part.trim())
    .filter((part) => part !== '')
    .map((part) => (/^\d+$/.test(part) ? Number(part) : part));
  return parts.length === 1 ? (parts[0] ?? 200) : parts;
}

function formatStatuses(equals: number | string | readonly (number | string)[]): string {
  return Array.isArray(equals) ? equals.join(', ') : String(equals);
}

export interface AssertionTableProps<A extends StepAssertionWire = StepAssertionWire> {
  readonly assertions: readonly A[];
  readonly onChange: (assertions: A[]) => void;
  readonly kinds?: readonly AssertionKind[];
  readonly testIdPrefix?: string;
  readonly emptyText?: string;
}

export function AssertionTable<A extends StepAssertionWire>({
  assertions,
  onChange,
  kinds = STEP_KINDS,
  testIdPrefix = 'sequence',
  emptyText = 'No assertions of the step’s own.',
}: AssertionTableProps<A>) {
  const hooks = useWebhooksStore((state) => state.hooks);
  const catchUrls = hooks.map((hook) => hook.name);
  const options = kinds.map((value) => ({ value, label: LABELS[value] }));
  const replace = (index: number, next: StepAssertionWire): void =>
    onChange(assertions.map((assertion, i) => (i === index ? (next as A) : assertion)));

  return (
    <div data-testid={`${testIdPrefix}-assertions`}>
      {assertions.length === 0 ? (
        <p className="py-1 text-sm text-fg-subtle">{emptyText}</p>
      ) : (
        <ul>
          {assertions.map((assertion, index) => (
            <FieldRow
              key={index}
              testId={`${testIdPrefix}-assertion-row`}
              removeLabel="Remove assertion"
              onRemove={() => onChange(assertions.filter((_, i) => i !== index))}
            >
              <SelectField
                label="Assertion"
                testId={`${testIdPrefix}-assertion-kind`}
                value={assertion.type}
                options={options}
                onChange={(kind) => replace(index, defaultOf(kind, catchUrls))}
              />
              {assertion.type === 'status' && (
                <CommitInput
                  label="Expected status"
                  testId={`${testIdPrefix}-assertion-status`}
                  className="w-32"
                  value={formatStatuses(assertion.equals)}
                  placeholder="200, 2xx"
                  onCommit={(text) => replace(index, { ...assertion, equals: parseStatuses(text) })}
                />
              )}
              {assertion.type === 'sla' && (
                <CommitInput
                  label="Maximum milliseconds"
                  className="w-24"
                  value={String(assertion.maxMs)}
                  onCommit={(text) => {
                    const maxMs = Number(text);
                    if (Number.isInteger(maxMs) && maxMs > 0) {
                      replace(index, { ...assertion, maxMs });
                    }
                  }}
                />
              )}
              {assertion.type === 'soap-fault' && (
                <SelectField
                  label="Fault"
                  value={assertion.expect}
                  options={[
                    { value: 'none', label: 'no fault' },
                    { value: 'present', label: 'a fault' },
                  ]}
                  onChange={(expect) => replace(index, { ...assertion, expect })}
                />
              )}
              {assertion.type === 'match' && (
                <>
                  <SelectField
                    label="Language"
                    value={assertion.language}
                    options={LANGUAGES}
                    onChange={(language) => replace(index, { ...assertion, language })}
                  />
                  <CommitInput
                    label="Expression"
                    monospace
                    className="min-w-40 flex-1"
                    value={assertion.expression}
                    onCommit={(expression) => replace(index, { ...assertion, expression })}
                  />
                </>
              )}
              {assertion.type === 'header' && (
                <CommitInput
                  label="Header name"
                  className="w-40"
                  value={assertion.header}
                  onCommit={(header) => replace(index, { ...assertion, header })}
                />
              )}
              {assertion.type === 'callback' && (
                <CallbackFields assertion={assertion} onChange={(next) => replace(index, next)} />
              )}
              {(assertion.type === 'match' || assertion.type === 'header') && (
                <CheckEditor
                  value={assertion}
                  onChange={(fields) => replace(index, { ...withoutCheck(assertion), ...fields } as StepAssertionWire)}
                />
              )}
            </FieldRow>
          ))}
        </ul>
      )}
      <button
        type="button"
        data-testid={`${testIdPrefix}-add-assertion`}
        className="mt-1 text-sm text-accent hover:underline"
        onClick={() => onChange([...assertions, defaultOf(kinds[0] ?? 'status', catchUrls) as A])}
      >
        Add assertion
      </button>
    </div>
  );
}
