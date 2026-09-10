import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import type { PropertyMapWire } from '../../../shared/wire-types.js';

export interface PropertyTableProps {
  /** Accessible name of the table — e.g. `Project properties`. */
  readonly label: string;
  readonly properties: PropertyMapWire;
  /** Sets (or overwrites) one property. */
  readonly onSet: (name: string, value: string) => void;
  readonly onRemove: (name: string) => void;
  /**
   * Renames one property, keeping its value. Optional: without it a rename is done as a
   * remove followed by a set, which is two round trips and briefly loses the ordering.
   */
  readonly onRename?: (from: string, to: string) => void;
  readonly emptyMessage?: string;
}

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

interface RowProps {
  readonly name: string;
  readonly value: string;
  readonly onCommitName: (next: string) => void;
  readonly onCommitValue: (next: string) => void;
  readonly onRemove: () => void;
}

/** One name/value pair. Edits are local until Enter or blur, so a keystroke is never a mutation. */
function PropertyRow({ name, value, onCommitName, onCommitValue, onRemove }: RowProps) {
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftName(name);
  }, [name]);
  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <tr>
      <td className="py-0.5 pr-2">
        <input
          aria-label={`Name of ${name}`}
          data-testid="property-name"
          className={INPUT_CLASS}
          value={draftName}
          onChange={(event) => {
            setDraftName(event.target.value);
          }}
          onBlur={() => {
            onCommitName(draftName);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommitName(draftName);
            }
            if (event.key === 'Escape') {
              setDraftName(name);
            }
          }}
        />
      </td>
      <td className="py-0.5 pr-2">
        <input
          aria-label={`Value of ${name}`}
          data-testid="property-value"
          className={INPUT_CLASS}
          value={draftValue}
          onChange={(event) => {
            setDraftValue(event.target.value);
          }}
          onBlur={() => {
            onCommitValue(draftValue);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              onCommitValue(draftValue);
            }
            if (event.key === 'Escape') {
              setDraftValue(value);
            }
          }}
        />
      </td>
      <td className="w-8 py-0.5">
        <IconButton label={`Remove ${name}`} onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </td>
    </tr>
  );
}

/**
 * The name/value editor every property scope shares — project, environment, and global. It
 * owns no data: the caller passes the map and three callbacks, so the same table drives an
 * IPC-backed store or an environment patch that replaces the whole map.
 */
export function PropertyTable({
  label,
  properties,
  onSet,
  onRemove,
  onRename,
  emptyMessage = 'No properties yet.',
}: PropertyTableProps) {
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const names = Object.keys(properties).sort((a, b) => a.localeCompare(b));

  const rename = (from: string, to: string): void => {
    const trimmed = to.trim();
    if (trimmed === from || trimmed.length === 0) {
      return;
    }
    if (Object.hasOwn(properties, trimmed)) {
      setError(`A property named "${trimmed}" already exists.`);
      return;
    }
    setError(undefined);
    if (onRename !== undefined) {
      onRename(from, trimmed);
      return;
    }
    onRemove(from);
    onSet(trimmed, properties[from] ?? '');
  };

  const add = (): void => {
    const trimmed = newName.trim();
    if (trimmed.length === 0) {
      setError('A property needs a name.');
      return;
    }
    if (Object.hasOwn(properties, trimmed)) {
      setError(`A property named "${trimmed}" already exists.`);
      return;
    }
    setError(undefined);
    onSet(trimmed, newValue);
    setNewName('');
    setNewValue('');
  };

  return (
    <div className="flex flex-col gap-2">
      {names.length === 0 ? (
        <p className="text-sm text-fg-subtle">{emptyMessage}</p>
      ) : (
        <table aria-label={label} className="w-full table-fixed border-collapse text-sm">
          <thead>
            <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
              <th className="pb-1 font-medium">Name</th>
              <th className="pb-1 font-medium">Value</th>
              <th className="w-8" />
            </tr>
          </thead>
          <tbody>
            {names.map((name) => (
              <PropertyRow
                key={name}
                name={name}
                value={properties[name] ?? ''}
                onCommitName={(next) => {
                  rename(name, next);
                }}
                onCommitValue={(next) => {
                  if (next !== properties[name]) {
                    onSet(name, next);
                  }
                }}
                onRemove={() => {
                  onRemove(name);
                }}
              />
            ))}
          </tbody>
        </table>
      )}

      <div className="flex items-center gap-2">
        <input
          aria-label="New property name"
          placeholder="name"
          className={INPUT_CLASS}
          value={newName}
          onChange={(event) => {
            setNewName(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              add();
            }
          }}
        />
        <input
          aria-label="New property value"
          placeholder="value"
          className={INPUT_CLASS}
          value={newValue}
          onChange={(event) => {
            setNewValue(event.target.value);
          }}
          onKeyDown={(event) => {
            if (event.key === 'Enter') {
              add();
            }
          }}
        />
        <button
          type="button"
          onClick={add}
          className="h-row shrink-0 rounded-md border border-hairline-strong bg-surface-raised px-3 text-sm text-fg-default hover:bg-surface-hover"
        >
          Add property
        </button>
      </div>

      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
