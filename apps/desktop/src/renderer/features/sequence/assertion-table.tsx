/**
 * A step's own assertions, evaluated after its request's own. The catalogue is the runner's (status,
 * SOAP fault, match, schema, response time) plus `header` and `callback`, which only a step may use.
 */
import type { StepAssertionWire } from '../../../shared/wire-types.js';
import { useWebhooksStore } from '../../state/webhooks.js';
import { CallbackFields } from './callback-fields.js';
import { CALLBACK_BOUNDS } from './callback-text.js';
import { CheckEditor } from './check-editor.js';
import { CommitInput, FieldRow, SelectField } from './step-fields.js';

type Kind = StepAssertionWire['type'];

const KINDS: readonly { value: Kind; label: string }[] = [
  { value: 'status', label: 'Status' },
  { value: 'header', label: 'Header' },
  { value: 'match', label: 'Body matches' },
  { value: 'sla', label: 'Response time' },
  { value: 'soap-fault', label: 'SOAP fault' },
  { value: 'schema', label: 'Schema' },
  { value: 'callback', label: 'Callback' },
];

const LANGUAGES = [
  { value: 'jsonpath', label: 'JSONPath' },
  { value: 'xpath', label: 'XPath' },
  { value: 'xquery', label: 'XQuery' },
] as const;

/** A new assertion of `kind`; a callback starts from the first catch URL the workspace knows. */
function defaultOf(kind: Kind, catchUrls: readonly string[]): StepAssertionWire {
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

export interface AssertionTableProps {
  readonly assertions: readonly StepAssertionWire[];
  readonly onChange: (assertions: StepAssertionWire[]) => void;
}

export function AssertionTable({ assertions, onChange }: AssertionTableProps) {
  const hooks = useWebhooksStore((state) => state.hooks);
  const catchUrls = hooks.map((hook) => hook.name);
  const replace = (index: number, next: StepAssertionWire): void =>
    onChange(assertions.map((assertion, i) => (i === index ? next : assertion)));

  return (
    <div data-testid="sequence-assertions">
      {assertions.length === 0 ? (
        <p className="py-1 text-sm text-fg-subtle">No assertions of the step’s own.</p>
      ) : (
        <ul>
          {assertions.map((assertion, index) => (
            <FieldRow
              key={index}
              testId="sequence-assertion-row"
              removeLabel="Remove assertion"
              onRemove={() => onChange(assertions.filter((_, i) => i !== index))}
            >
              <SelectField
                label="Assertion"
                testId="sequence-assertion-kind"
                value={assertion.type}
                options={KINDS}
                onChange={(kind) => replace(index, defaultOf(kind, catchUrls))}
              />
              {assertion.type === 'status' && (
                <CommitInput
                  label="Expected status"
                  testId="sequence-assertion-status"
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
        data-testid="sequence-add-assertion"
        className="mt-1 text-sm text-accent hover:underline"
        onClick={() => onChange([...assertions, defaultOf('status', catchUrls)])}
      >
        Add assertion
      </button>
    </div>
  );
}
