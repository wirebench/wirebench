import { useEffect, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import type { PropertyMapWire } from '../../../shared/wire-types.js';

/**
 * A scope below this one in the precedence chain, nearest first — Workspace and Globals below an
 * environment, Globals below Workspace, and so on. This table never writes to one of these: a
 * name defined only here renders in the read-only "Inherited" group, and a name this scope also
 * defines uses it only to say what it shadows.
 */
export interface InheritedScope {
  /** What this scope is called in the origin column — 'Workspace', 'Globals', a project name. */
  readonly label: string;
  readonly properties: PropertyMapWire;
  readonly disabled: readonly string[];
}

/**
 * What one variables table edits: the map, which names are disabled, and how to save each kind
 * of edit. Callback-shaped per edit kind, plus the Enabled column and its own testids —
 * one component for Globals, Workspace, and every environment (workspace or project); Task 7
 * binds the same component to a project's own properties by passing a different target.
 */
export interface VariablesTableTarget {
  /** Accessible name of the table — e.g. `Globals variables`. */
  readonly label: string;
  /** What this scope is called in the origin column — 'This environment', 'Workspace', 'Globals'. */
  readonly scopeLabel: string;
  readonly properties: PropertyMapWire;
  /** Names in `properties` currently disabled (skipped during resolution, not deleted). */
  readonly disabled: readonly string[];
  /**
   * Scopes this one falls back to, nearest first. Absent means nothing is inherited — Globals,
   * the chain's root.
   */
  readonly inherited?: readonly InheritedScope[];
  /** Sets (or overwrites) one variable. */
  readonly onSet: (name: string, value: string) => void;
  readonly onRemove: (name: string) => void;
  /**
   * Renames one variable, keeping its value and its enabled state. Optional: without it a
   * rename is done as a remove followed by a set (and, for a disabled variable, a third call
   * re-asserting the flag under the new name — every writer prunes a `disabled` entry with no
   * matching property, so the remove drops it).
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

/** True when `scope` defines `name` at all, whether or not it disables it there. */
function defines(scope: { readonly properties: PropertyMapWire }, name: string): boolean {
  return Object.hasOwn(scope.properties, name);
}

/**
 * The nearest scope in `chain` that defines `name`, disabled there or not — "nearest scope wins
 * when several define the same name" for display: who a shadowed or inherited value would point
 * back to.
 */
function nearestDefining(name: string, chain: readonly InheritedScope[]): InheritedScope | undefined {
  return chain.find((scope) => defines(scope, name));
}

/**
 * The scope that actually wins resolution of `name` among `chain`: the first that both defines it
 * and does not disable it there. A scope that defines a name but disables it does not win —
 * resolution continues past it to the next scope in the chain.
 */
function resolvingScope(name: string, chain: readonly InheritedScope[]): InheritedScope | undefined {
  return chain.find((scope) => defines(scope, name) && !scope.disabled.includes(name));
}

/** The `Resolves from` text for a row defined in this scope's own `properties`. */
function ownOrigin(params: {
  readonly scopeLabel: string;
  readonly enabled: boolean;
  readonly name: string;
  readonly inherited: readonly InheritedScope[];
}): string {
  const { scopeLabel, enabled, name, inherited } = params;
  if (enabled) {
    const shadowed = nearestDefining(name, inherited);
    return shadowed === undefined ? scopeLabel : `${scopeLabel} · shadows ${shadowed.label}`;
  }
  const winner = resolvingScope(name, inherited);
  return winner === undefined ? 'Off — no value resolves' : `Off — falls through to ${winner.label}`;
}

const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-hairline-strong bg-surface-raised px-2 font-mono text-sm text-fg-default focus:outline-none focus:ring-1 focus:ring-accent';

interface RowProps {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  readonly readOnlyEnabled: boolean;
  /** The `Resolves from` column's text — see {@link ownOrigin}. */
  readonly origin: string;
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
  origin,
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
      <td className="py-0.5 pr-2 text-xs text-fg-subtle" data-testid="env-variable-origin">
        {origin}
      </td>
      <td className="w-8 py-0.5">
        <IconButton label={`Remove ${name}`} data-testid="env-variable-delete" onClick={onRemove}>
          <Trash2 size={13} aria-hidden="true" />
        </IconButton>
      </td>
    </tr>
  );
}

interface InheritedRowProps {
  readonly name: string;
  readonly value: string;
  readonly enabled: boolean;
  /** The scope that owns this value — named in the Enabled checkbox's title and the origin cell. */
  readonly ownerLabel: string;
}

/**
 * One name inherited from a scope below this one. Read-only: the name and value are shown but not
 * editable, there is no delete, and the Enabled checkbox is `disabled` with a title naming the
 * scope that owns it — this table can only show what a lower scope resolves to, not change it.
 */
function InheritedVariableRow({ name, value, enabled, ownerLabel }: InheritedRowProps) {
  return (
    <tr data-testid="env-variable-row" className={enabled ? undefined : 'opacity-50'}>
      <td className="w-8 py-0.5 pr-2 text-center">
        <input
          type="checkbox"
          aria-label={`Enable ${name}`}
          data-testid="env-variable-enabled"
          checked={enabled}
          disabled
          title={`Set in ${ownerLabel} — edit it there.`}
          readOnly
        />
      </td>
      <td className="py-0.5 pr-2">
        <input
          aria-label={`Name of ${name}`}
          data-testid="env-variable-name"
          className={INPUT_CLASS}
          value={name}
          readOnly
        />
      </td>
      <td className="py-0.5 pr-2">
        <input
          aria-label={`Value of ${name}`}
          data-testid="env-variable-value"
          className={INPUT_CLASS}
          value={value}
          readOnly
        />
      </td>
      <td className="py-0.5 pr-2 text-xs text-fg-subtle" data-testid="env-variable-origin">
        {ownerLabel}
      </td>
      <td className="w-8 py-0.5" />
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
    scopeLabel,
    properties,
    disabled,
    inherited = [],
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

  // Group 2: names some inherited scope defines that this scope's own `properties` does not —
  // "Set here" always wins the row (edited here), regardless of whether it's enabled.
  const inheritedNames = new Set<string>();
  for (const scope of inherited) {
    for (const key of Object.keys(scope.properties)) {
      inheritedNames.add(key);
    }
  }
  const inheritedOnlyNames = [...inheritedNames]
    .filter((name) => !Object.hasOwn(properties, name))
    .sort((a, b) => a.localeCompare(b));

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
    // The remove takes the `disabled` entry with it (every writer prunes names with no matching
    // property), so a disabled variable would come back enabled — and start resolving again —
    // unless the flag is re-asserted under the new name.
    if (disabledSet.has(from)) {
      onSetEnabled?.(trimmed, false);
    }
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
            <th className="pb-1 font-medium">Resolves from</th>
            <th className="w-8" />
          </tr>
        </thead>
        <tbody>
          {names.length === 0 && inheritedOnlyNames.length === 0 && (
            <tr>
              <td colSpan={5} className="py-1 text-sm text-fg-subtle">
                {emptyMessage}
              </td>
            </tr>
          )}
          {names.length > 0 && (
            <tr data-testid="env-variable-group">
              <th
                scope="colgroup"
                colSpan={5}
                className="pt-2 pb-0.5 text-left text-xs font-medium tracking-wider text-fg-subtle uppercase"
              >
                {`Set here · ${scopeLabel}`}
              </th>
            </tr>
          )}
          {names.map((name) => {
            const enabled = !disabledSet.has(name);
            return (
              <VariableRow
                key={name}
                name={name}
                value={properties[name] ?? ''}
                enabled={enabled}
                readOnlyEnabled={onSetEnabled === undefined}
                origin={ownOrigin({ scopeLabel, enabled, name, inherited })}
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
            );
          })}
          {inheritedOnlyNames.length > 0 && (
            <tr data-testid="env-variable-group">
              <th
                scope="colgroup"
                colSpan={5}
                className="pt-2 pb-0.5 text-left text-xs font-medium tracking-wider text-fg-subtle uppercase"
              >
                Inherited · read-only
              </th>
            </tr>
          )}
          {inheritedOnlyNames.map((name) => {
            const owner = nearestDefining(name, inherited);
            // `inheritedOnlyNames` was built from these same scopes, so a definer always exists.
            if (owner === undefined) {
              return null;
            }
            return (
              <InheritedVariableRow
                key={name}
                name={name}
                value={owner.properties[name] ?? ''}
                enabled={!owner.disabled.includes(name)}
                ownerLabel={owner.label}
              />
            );
          })}
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
            {/* Stage 2 fills this in with a live "will shadow {X}" hint while typing the name. */}
            <td className="w-8 py-0.5" />
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
