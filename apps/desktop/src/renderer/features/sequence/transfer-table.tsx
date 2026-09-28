/**
 * A step's transfers: what it lifts from its response for the steps after it, as `${#Sequence#name}`.
 * Marking one secret masks it everywhere from the moment it is lifted, and the run panel never shows it.
 */
import type { SequenceTransferWire } from '../../../shared/wire-types.js';
import { CheckField, CommitInput, FieldRow, SelectField } from './step-fields.js';

type Source = SequenceTransferWire['from'];

const SOURCES: readonly { value: Source; label: string }[] = [
  { value: 'body', label: 'Body' },
  { value: 'header', label: 'Header' },
  { value: 'cookie', label: 'Cookie' },
  { value: 'status', label: 'Status' },
];

const LANGUAGES = [
  { value: 'jsonpath', label: 'JSONPath' },
  { value: 'xpath', label: 'XPath' },
  { value: 'xquery', label: 'XQuery' },
] as const;

/** The same transfer read from another source, keeping its name and flags. */
function withSource(transfer: SequenceTransferWire, from: Source): SequenceTransferWire {
  const base = {
    name: transfer.name,
    ...(transfer.secret === true ? { secret: true } : {}),
    ...(transfer.optional === true ? { optional: true } : {}),
  };
  switch (from) {
    case 'body':
      return { ...base, from, language: 'jsonpath', expression: '$' };
    case 'header':
      return { ...base, from, header: 'Location' };
    case 'cookie':
      return { ...base, from, cookie: 'session' };
    case 'status':
      return { ...base, from };
  }
}

/** A name not yet used by `transfers`. */
function freshName(transfers: readonly SequenceTransferWire[]): string {
  const taken = new Set(transfers.map((transfer) => transfer.name));
  for (let n = 1; ; n += 1) {
    const name = n === 1 ? 'value' : `value${n}`;
    if (!taken.has(name)) {
      return name;
    }
  }
}

export interface TransferTableProps {
  readonly transfers: readonly SequenceTransferWire[];
  readonly onChange: (transfers: SequenceTransferWire[]) => void;
}

export function TransferTable({ transfers, onChange }: TransferTableProps) {
  const replace = (index: number, next: SequenceTransferWire): void =>
    onChange(transfers.map((transfer, i) => (i === index ? next : transfer)));

  return (
    <div data-testid="sequence-transfers">
      {transfers.length === 0 ? (
        <p className="py-1 text-sm text-fg-subtle">
          Nothing is lifted from this step’s response. Add a transfer to use a value in later steps.
        </p>
      ) : (
        <ul>
          {transfers.map((transfer, index) => (
            <FieldRow
              key={index}
              testId="sequence-transfer-row"
              removeLabel={`Remove transfer ${transfer.name}`}
              onRemove={() => onChange(transfers.filter((_, i) => i !== index))}
            >
              <CommitInput
                label="Transfer name"
                testId="sequence-transfer-name"
                monospace
                className="w-32"
                value={transfer.name}
                onCommit={(name) => replace(index, { ...transfer, name })}
              />
              <SelectField
                label="Source"
                testId="sequence-transfer-source"
                value={transfer.from}
                options={SOURCES}
                onChange={(from) => replace(index, withSource(transfer, from))}
              />
              {transfer.from === 'body' && (
                <>
                  <SelectField
                    label="Language"
                    value={transfer.language}
                    options={LANGUAGES}
                    onChange={(language) => replace(index, { ...transfer, language })}
                  />
                  <CommitInput
                    label="Expression"
                    testId="sequence-transfer-expression"
                    monospace
                    className="min-w-40 flex-1"
                    value={transfer.expression}
                    onCommit={(expression) => replace(index, { ...transfer, expression })}
                  />
                </>
              )}
              {transfer.from === 'header' && (
                <CommitInput
                  label="Header name"
                  className="min-w-40 flex-1"
                  value={transfer.header}
                  onCommit={(header) => replace(index, { ...transfer, header })}
                />
              )}
              {transfer.from === 'cookie' && (
                <CommitInput
                  label="Cookie name"
                  className="min-w-40 flex-1"
                  value={transfer.cookie}
                  onCommit={(cookie) => replace(index, { ...transfer, cookie })}
                />
              )}
              <CheckField
                label="Secret"
                testId="sequence-transfer-secret"
                checked={transfer.secret === true}
                onChange={(secret) => replace(index, { ...transfer, secret })}
              />
              <CheckField
                label="Optional"
                checked={transfer.optional === true}
                onChange={(optional) => replace(index, { ...transfer, optional })}
              />
            </FieldRow>
          ))}
        </ul>
      )}
      <button
        type="button"
        data-testid="sequence-add-transfer"
        className="mt-1 text-sm text-accent hover:underline"
        onClick={() =>
          onChange([...transfers, { name: freshName(transfers), from: 'body', language: 'jsonpath', expression: '$' }])
        }
      >
        Add transfer
      </button>
    </div>
  );
}
