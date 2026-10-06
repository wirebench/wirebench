import type { SecretSourceEntryWire } from '../../../shared/wire-types.js';
import { KIND_FIELDS } from './kind-fields.js';

/** An entry's locator fields as `key: value`; never a secret's value. */
export function EntryLocation({ entry }: { readonly entry: SecretSourceEntryWire }) {
  // An invalid entry shows every raw field it has, so what an approval covers is visible.
  const keys = Object.keys(entry.fields).filter((key) => entryProblem(entry) !== undefined || key !== 'kind');
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

/**
 * Why the dialog must not edit an entry: main marked it invalid, or it holds a kind or fields this form cannot
 * show, so saving it would drop them. Such an entry is displayed as invalid and can only be removed.
 */
export function entryProblem(entry: SecretSourceEntryWire): string | undefined {
  if (entry.kind === 'invalid') {
    return entry.reason ?? 'not a valid entry';
  }
  const known = KIND_FIELDS[entry.kind];
  if (known === undefined) {
    return `unknown kind "${entry.kind}"`;
  }
  const extra = Object.keys(entry.fields).filter(
    (key) => key !== 'kind' && !known.required.includes(key) && !known.optional.includes(key),
  );
  return extra.length > 0 ? `fields this dialog cannot show: ${extra.join(', ')}` : undefined;
}

/** The Kind cell: the kind, or `Invalid: <reason>` for an entry the dialog must not edit. */
export function kindLabel(entry: SecretSourceEntryWire): string {
  const problem = entryProblem(entry);
  return problem === undefined ? entry.kind : `Invalid: ${problem}`;
}
