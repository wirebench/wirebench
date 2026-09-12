import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import type { PropertyMapWire } from '../../../shared/wire-types.js';

/**
 * What one variables table edits: the map, which names are disabled, and how to save each kind
 * of edit. Callback-shaped like `PropertyTable`, plus the Enabled column and its own testids —
 * one component for Globals, Workspace, and every environment (workspace or project); Task 7
 * binds the same component to a project's own properties by passing a different target.
 */
export interface VariablesTableTarget {
  /** Accessible name of the table — e.g. `Globals variables`. */
  readonly label: string;
  readonly properties: PropertyMapWire;
  /** Names in `properties` currently disabled (skipped during resolution, not deleted). */
  readonly disabled: readonly string[];
  /** Sets (or overwrites) one variable. */
  readonly onSet: (name: string, value: string) => void;
  readonly onRemove: (name: string) => void;
  /**
   * Renames one variable, keeping its value and its enabled state. Optional: without it a
   * rename is done as a remove followed by a set, which is two round trips.
   */
  readonly onRename?: (from: string, to: string) => void;
  /**
   * Toggles one variable's disabled flag. Omitted when the scope has no way to write it back —
   * a linked project's own environment publishes `disabled` read-only on the wire — in which
   * case the Enabled column still shows the current state, just not interactively.
   */
  readonly onSetEnabled?: (name: string, enabled: boolean) => void;
  readonly emptyMessage?: string;
}

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

interface RowProps {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly readOnlyEnabled: boolean;
  readonly onCommitName: (next: string) => void;
  readonly onCommitValue: (next: string) => void;
  readonly onToggleEnabled: (next: boolean) => void;
  readonly onRemove: () => void;
}

/** One name/value pair. Edits are local until Enter, Tab or blur, so a keystroke is never a mutation. */
function VariableRow({
  name,
  value,
  enabled,
  readOnlyEnabled,
  onCommitName,
  onCommitValue,
  onToggleEnabled,
  onRemove,
}: RowProps) {
  const [draftName, setDraftName] = useState(name);
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftName(name);
  }, [name]);
  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <tr data-testid="env-variable-row" className={enabled ? undefined : 'opacity-50'}>
      <td className="w-8 py-0.5 pr-2 text-center">
        <input
          type="checkbox"
          aria-label={`Enable ${name}`}
          data-testid="env-variable-enabled"
          checked={enabled}
          disabled={readOnlyEnabled}
          title={
            readOnlyEnabled ? "A linked project's own environment variables are managed in that project." : undefined
          }
          onChange={(event) => {
            onToggleEnabled(event.target.checked);
          }}
        />
      </td>
      <td className="py-0.5 pr-2">
        <input
          aria-label={`Name of ${name}`}
          data-testid="env-variable-name"
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
          data-testid="env-variable-value"
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
        <IconButton label={`Remove ${name}`} data-testid="env-variable-delete" onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </td>
    </tr>
  );
}

/**
 * The name/value/enabled editor every "variables" scope shares — Globals, Workspace, every
 * environment, and (Task 7) a project's own properties. It owns no data: the caller passes a
 * {@link VariablesTableTarget} bundling the map and the callbacks that save an edit, so the same
 * table drives whichever IPC-backed store or queued environment patch the target needs.
 */
export function VariablesTable({ target }: { readonly target: VariablesTableTarget }) {
  const {
    label,
    properties,
    disabled,
    onSet,
    onRemove,
    onRename,
    onSetEnabled,
    emptyMessage = 'No variables yet.',
  } = target;
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);

  const disabledSet = new Set(disabled);
  const names = Object.keys(properties).sort((a, b) => a.localeCompare(b));

  const rename = (from: string, to: string): void => {
    const trimmed = to.trim();
    if (trimmed === from) {
      return;
    }
    if (trimmed.length === 0) {
      setError('A variable needs a name.');
      return;
    }
    if (Object.hasOwn(properties, trimmed)) {
      setError(`A variable named "${trimmed}" already exists.`);
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
      if (newValue.trim().length === 0) {
        // Both fields empty is not an error worth surfacing — the add row is always present.
        return;
      }
      setError('A variable needs a name.');
      return;
    }
    if (Object.hasOwn(properties, trimmed)) {
      setError(`A variable named "${trimmed}" already exists.`);
      return;
    }
    setError(undefined);
    onSet(trimmed, newValue);
    setNewName('');
    setNewValue('');
  };

  return (
    <div className="flex flex-col gap-2">
      <table aria-label={label} data-testid="env-variable-table" className="w-full table-fixed border-collapse text-sm">
        <thead>
          <tr className="text-left text-xs tracking-wider text-fg-subtle uppercase">
            <th className="w-8 pb-1 font-medium">Enabled</th>
            <th className="pb-1 font-medium">Variable</th>
            <th className="pb-1 font-medium">Value</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {names.length === 0 && (
            <tr>
              <td colSpan={4} className="py-1 text-sm text-fg-subtle">
                {emptyMessage}
              </td>
            </tr>
          )}
          {names.map((name) => (
            <VariableRow
              key={name}
              name={name}
              value={properties[name] ?? ''}
              enabled={!disabledSet.has(name)}
              readOnlyEnabled={onSetEnabled === undefined}
              onCommitName={(next) => {
                rename(name, next);
              }}
              onCommitValue={(next) => {
                if (next !== properties[name]) {
                  onSet(name, next);
                }
              }}
              onToggleEnabled={(next) => {
                onSetEnabled?.(name, next);
              }}
              onRemove={() => {
                onRemove(name);
              }}
            />
          ))}
          <tr data-testid="env-variable-row">
            <td className="w-8 py-0.5 pr-2 text-center">
              <input type="checkbox" aria-label="New variable enabled" checked disabled />
            </td>
            <td className="py-0.5 pr-2">
              <input
                aria-label="New variable name"
                data-testid="env-variable-name"
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
                  if (event.key === 'Escape') {
                    setNewName('');
                  }
                }}
              />
            </td>
            <td className="py-0.5 pr-2">
              <input
                aria-label="New variable value"
                data-testid="env-variable-value"
                placeholder="value"
                className={INPUT_CLASS}
                value={newValue}
                onChange={(event) => {
                  setNewValue(event.target.value);
                }}
                onBlur={add}
                onKeyDown={(event) => {
                  if (event.key === 'Enter') {
                    add();
                  }
                  if (event.key === 'Escape') {
                    setNewValue('');
                  }
                }}
              />
            </td>
            <td className="w-8 py-0.5" />
          </tr>
        </tbody>
      </table>

      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
