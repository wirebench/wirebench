import type { SecretSourceEntryWire } from '../../../shared/wire-types.js';

/** An entry's locator fields as `key: value`; never a secret's value. */
export function EntryLocation({ entry }: { readonly entry: SecretSourceEntryWire }) {
  // An invalid entry shows every raw field it has, so what an approval covers is visible.
  const keys = Object.keys(entry.fields).filter((key) => entry.kind === 'invalid' || key !== 'kind');
  return (
    <>
      {keys.map((key) => (
        <div key={key} className="font-mono text-xs">
          <span className="text-fg-subtle">{key}</span>: <span className="text-fg-default">{entry.fields[key]}</span>
        </div>
      ))}
    </>
  );
}

/** The Kind cell: the kind, or `Invalid: <reason>` for an entry the dialog must not edit. */
export function kindLabel(entry: SecretSourceEntryWire): string {
  return entry.kind === 'invalid' ? `Invalid: ${entry.reason ?? 'not a valid entry'}` : entry.kind;
}
