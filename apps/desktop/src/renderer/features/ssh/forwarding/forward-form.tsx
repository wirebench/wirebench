import { useId, type ReactNode } from 'react';
import type { ForwardEntryWire } from '../../../../shared/ssh-wire.js';
import { INPUT_CLASS } from '../inherited-field.js';
import { isNetworkBind, listenAddress } from './forward-format.js';

/** A full rule as written in hosts.yaml: what the form edits. */
export type ForwardFullEntry = Extract<ForwardEntryWire, { type: string }>;

const TYPES: readonly { readonly id: ForwardFullEntry['type']; readonly label: string }[] = [
  { id: 'local', label: 'Local' },
  { id: 'remote', label: 'Remote' },
  { id: 'dynamic', label: 'Dynamic (SOCKS)' },
];

const RULE_ID = /^[a-z0-9][a-z0-9-]*$/;
const TARGET = /^(?:\[[^\]]+\]|[^:[\]\s]+):\d{1,5}$/;

/** The bind a rule listens on when it names none: this machine's loopback, or the server's for remote. */
export function defaultBind(type: ForwardFullEntry['type']): string {
  return type === 'remote' ? 'localhost' : '127.0.0.1';
}

/**
 * What stops a rule being saved, if anything; main checks the rest (a bind that is no address, an id used
 * twice on one level) and its refusal shows as for any host edit.
 */
export function forwardProblem(entry: ForwardFullEntry): string | undefined {
  if (!RULE_ID.test(entry.id)) return 'A name is lower-case letters, digits and dashes';
  if (!Number.isInteger(entry.port) || entry.port < 1 || entry.port > 65535) return 'A port is 1–65535';
  if (entry.type !== 'dynamic' && !TARGET.test(entry.target ?? '')) return 'A target is host:port';
  return undefined;
}

/** `entry` without `key`; for the optional fields the form clears. */
function without<K extends keyof ForwardFullEntry>(entry: ForwardFullEntry, key: K): ForwardFullEntry {
  const { [key]: dropped, ...rest } = entry;
  void dropped;
  return rest as ForwardFullEntry;
}

export interface ForwardFormProps {
  readonly entry: ForwardFullEntry;
  readonly onChange: (entry: ForwardFullEntry) => void;
  /** Absent for an override, which its switch takes away instead. */
  readonly onRemove?: () => void;
  /** "overrides Production" for a rule copied from a group above. */
  readonly note?: string;
}

/**
 * One rule's fields: id, type, port, bind (its default shown; a network address warns inline), target
 * (none for dynamic) and whether it starts with the host's terminals.
 */
export function ForwardForm({ entry, onChange, onRemove, note }: ForwardFormProps) {
  const id = useId();
  const bind = entry.bind ?? '';
  const network = bind !== '' && isNetworkBind(bind);
  const problem = forwardProblem(entry);
  const field = (label: string, input: ReactNode) => (
    <label className="flex flex-col gap-1 text-xs">
      <span className="text-fg-subtle">{label}</span>
      {input}
    </label>
  );
  return (
    <fieldset
      data-testid="forward-form"
      aria-label={entry.id === '' ? 'New rule' : `Rule ${entry.id}`}
      className="flex flex-col gap-2 rounded-md border border-hairline p-2"
    >
      <div className="flex items-center gap-2">
        <span className="text-xs font-medium text-fg-default">{entry.id === '' ? 'New rule' : entry.id}</span>
        {note !== undefined && <span className="text-xs text-fg-subtle">{note}</span>}
        {onRemove !== undefined && (
          <button
            type="button"
            onClick={onRemove}
            className="ml-auto rounded px-1.5 text-xs text-fg-subtle hover:bg-surface-hover hover:text-fg-default"
          >
            Remove
          </button>
        )}
      </div>
      <div role="radiogroup" aria-label="Type" className="flex gap-3 text-xs">
        {TYPES.map((type) => (
          <label key={type.id} className="flex items-center gap-1 text-fg-default">
            <input
              type="radio"
              name={`${id}-type`}
              checked={entry.type === type.id}
              onChange={() => {
                const next = { ...entry, type: type.id };
                onChange(type.id === 'dynamic' ? without(next, 'target') : next);
              }}
            />
            {type.label}
          </label>
        ))}
      </div>
      <div className="grid grid-cols-2 gap-2">
        {field(
          'Name',
          <input
            className={INPUT_CLASS}
            value={entry.id}
            onChange={(e) => {
              onChange({ ...entry, id: e.target.value.trim() });
            }}
          />,
        )}
        {field(
          'Port',
          <input
            type="number"
            className={INPUT_CLASS}
            value={Number.isNaN(entry.port) ? '' : String(entry.port)}
            onChange={(e) => {
              onChange({ ...entry, port: e.target.value === '' ? Number.NaN : Number(e.target.value) });
            }}
          />,
        )}
        {field(
          'Bind',
          <input
            className={INPUT_CLASS}
            placeholder={defaultBind(entry.type)}
            value={bind}
            onChange={(e) => {
              const value = e.target.value.trim();
              onChange(value === '' ? without(entry, 'bind') : { ...entry, bind: value });
            }}
          />,
        )}
        {entry.type !== 'dynamic' &&
          field(
            entry.type === 'local' ? 'Target (as the host sees it)' : 'Target (as this machine sees it)',
            <input
              className={INPUT_CLASS}
              placeholder="localhost:5432"
              value={entry.target ?? ''}
              onChange={(e) => {
                const value = e.target.value.trim();
                onChange(value === '' ? without(entry, 'target') : { ...entry, target: value });
              }}
            />,
          )}
      </div>
      {network && (
        <p role="note" className="text-xs text-status-warning">
          {`Reachable from other machines at ${listenAddress(bind, Number.isNaN(entry.port) ? 0 : entry.port)}. The first start on this machine asks to confirm.`}
        </p>
      )}
      <label className="flex items-center gap-2 text-xs text-fg-default">
        <input
          type="checkbox"
          checked={entry.autoStart === true}
          onChange={(e) => {
            onChange(e.target.checked ? { ...entry, autoStart: true } : without(entry, 'autoStart'));
          }}
        />
        Start with the host&apos;s terminals
      </label>
      {problem !== undefined && entry.id !== '' && <p className="text-xs text-fg-subtle">{problem}</p>}
    </fieldset>
  );
}
