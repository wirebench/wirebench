import { useEffect, useRef, useState } from 'react';
import { Trash2 } from 'lucide-react';
import { IconButton } from '../../components/icon-button.js';
import { ConfirmDialog } from '../../components/confirm-dialog.js';
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
  /**
   * Sets (or overwrites) several variables at once, as one write. Optional: without it a batch
   * falls back to one {@link onSet} per pair, which is only safe for a target whose writer merges
   * per name (Globals, Workspace, a project's properties) or serialises its round trips (a
   * workspace environment's queue). A target that rebuilds a whole map from a render-time
   * snapshot MUST provide this, or every pair but the last is silently dropped.
   */
  readonly onSetMany?: (entries: readonly { readonly name: string; readonly value: string }[]) => void;
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
  /**
   * True when this scope cannot carry a disabled variable's flag through a rename — a linked
   * project's own environment publishes `disabled` read-only on the wire, so there is no write
   * that could move the flag to the new name. Renaming a disabled variable there would silently
   * re-enable it, so the table refuses the rename instead (same error surface as a duplicate
   * name) rather than performing it. Renaming an enabled variable is unaffected.
   */
  readonly renameDisabledUnsupported?: boolean;
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

/**
 * What an inherited-only row resolves to: the scope that wins, the scope whose value is shown
 * (the winner, or — when every definer disables the name — the nearest definer, so the row still
 * has something to show and something to override), and the `Resolves from` caption.
 *
 * The caption names the *winner*, because the column is a claim about what goes on the wire. A
 * nearer scope that defines the name but has it switched off is mentioned only to explain why
 * resolution skipped past it.
 */
function inheritedOrigin(
  name: string,
  chain: readonly InheritedScope[],
): { readonly owner: InheritedScope; readonly enabled: boolean; readonly origin: string } | undefined {
  const definer = nearestDefining(name, chain);
  if (definer === undefined) {
    return undefined;
  }
  const winner = resolvingScope(name, chain);
  if (winner === undefined) {
    return { owner: definer, enabled: false, origin: 'Off — no value resolves' };
  }
  return {
    owner: winner,
    enabled: true,
    origin: winner === definer ? winner.label : `${winner.label} · ${definer.label} has it off`,
  };
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
    // The winner, not the nearest definer: `shadows X` in the "Resolves from" column is a promise
    // that X is what would resolve without this row. A nearer scope that defines the name but has
    // it switched off contributes nothing, so naming it would promise a fallback that isn't there
    // — and would contradict the disabled branch below, which already names the winner.
    const shadowed = resolvingScope(name, inherited);
    return shadowed === undefined ? scopeLabel : `${scopeLabel} · shadows ${shadowed.label}`;
  }
  const winner = resolvingScope(name, inherited);
  return winner === undefined ? 'Off — no value resolves' : `Off — falls through to ${winner.label}`;
}

/** One `name=value` (or `name: value`) pair parsed out of a pasted block. */
interface PastedVariable {
  readonly name: string;
  readonly value: string;
}

/**
 * Parses a pasted block as one variable per line: `name=value` or `name: value`, blank lines and
 * `#`-comments ignored, whichever of `=`/`:` comes first on the line splitting it — so a value
 * containing `=` (a token, say) survives intact after an earlier `:` splits the line. Lines with
 * neither separator, or an empty name, are dropped. Returns an empty array when nothing on the
 * pasted block was usable, which the caller reads as "fall back to a plain-text paste".
 */
function parsePastedVariables(text: string): readonly PastedVariable[] {
  const items: PastedVariable[] = [];
  for (const rawLine of text.split(/\r\n|\r|\n/)) {
    const line = rawLine.trim();
    if (line.length === 0 || line.startsWith('#')) {
      continue;
    }
    const separators = [line.indexOf('='), line.indexOf(':')].filter((index) => index >= 0);
    if (separators.length === 0) {
      continue;
    }
    const at = Math.min(...separators);
    const name = line.slice(0, at).trim();
    const value = line.slice(at + 1).trim();
    if (name.length === 0) {
      continue;
    }
    items.push({ name, value });
  }
  return items;
}

// A transparent border by default so a row reads as data, not a form field; hover swaps only
// the border's colour (never adds one) so nothing shifts a pixel, and focus keeps the border
// transparent since the accent ring already marks it.
const INPUT_CLASS =
  'h-row w-full min-w-0 rounded-md border border-transparent bg-transparent px-2 font-mono text-sm text-fg-default hover:border-hairline-strong focus:border-transparent focus:outline-none focus:ring-1 focus:ring-accent';

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
    <tr
      data-testid="env-variable-row"
      className={`border-b border-hairline hover:bg-surface-hover ${enabled ? '' : 'opacity-50'}`}
    >
      <td className="px-2 py-1 text-center">
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
      <td className="px-2 py-1">
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
      <td className="px-2 py-1">
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
      <td className="px-2 py-1 text-xs text-fg-subtle" data-testid="env-variable-origin">
        {origin}
      </td>
      <td className="px-2 py-1 text-center">
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
  /** The scope this row's value comes from — named in the Enabled checkbox's and value's titles. */
  readonly ownerLabel: string;
  /** The `Resolves from` column's text — see {@link inheritedOrigin}. */
  readonly origin: string;
  /**
   * Commits a typed value, promoting this name into an override of `ownerLabel`'s value in this
   * scope's own properties. Committing (Enter or blur, matching every other row) is the only way
   * to create the override — there's no separate "override" button.
   */
  readonly onCommitValue: (next: string) => void;
}

/**
 * One name inherited from a scope below this one. Mostly read-only — the name stays fixed (this
 * overrides a specific inherited name, not a rename) and there's no delete or Enabled toggle
 * until an override exists — but the value is editable: committing a value here promotes the row
 * to an override, written into this scope's own properties via `onCommitValue`.
 */
function InheritedVariableRow({ name, value, enabled, ownerLabel, origin, onCommitValue }: InheritedRowProps) {
  const [draftValue, setDraftValue] = useState(value);

  useEffect(() => {
    setDraftValue(value);
  }, [value]);

  return (
    <tr
      data-testid="env-variable-row"
      className={`border-b border-hairline hover:bg-surface-hover ${enabled ? '' : 'opacity-50'}`}
    >
      <td className="px-2 py-1 text-center">
        <input
          type="checkbox"
          aria-label={`Enable ${name}`}
          data-testid="env-variable-enabled"
          checked={enabled}
          disabled
          title={`Set in ${ownerLabel} — edit it there, or override the value here.`}
          readOnly
        />
      </td>
      <td className="px-2 py-1">
        <input
          aria-label={`Name of ${name}`}
          data-testid="env-variable-name"
          className={INPUT_CLASS}
          value={name}
          readOnly
        />
      </td>
      <td className="px-2 py-1">
        <input
          aria-label={`Value of ${name}`}
          data-testid="env-variable-value"
          className={INPUT_CLASS}
          value={draftValue}
          title={`Override ${ownerLabel} here`}
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
      <td className="px-2 py-1 text-xs text-fg-subtle" data-testid="env-variable-origin">
        {origin}
      </td>
      <td className="px-2 py-1" />
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
    onSetMany,
    onRemove,
    onRename,
    onSetEnabled,
    renameDisabledUnsupported = false,
    emptyMessage = 'No variables yet.',
  } = target;
  const [newName, setNewName] = useState('');
  const [newValue, setNewValue] = useState('');
  const [error, setError] = useState<string | undefined>(undefined);
  const [pasteItems, setPasteItems] = useState<readonly PastedVariable[] | undefined>(undefined);
  const newNameRef = useRef<HTMLInputElement>(null);

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
    if (renameDisabledUnsupported && disabledSet.has(from)) {
      setError(`Re-enable "${from}" before renaming it.`);
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

  /** Puts focus back in the add row's name input so several variables can be typed in a row. */
  const focusNewName = (): void => {
    newNameRef.current?.focus();
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
    focusNewName();
  };

  /**
   * The add row's `will shadow {X}` hint — empty until the typed name matches an inherited definer.
   * Deliberately `nearestDefining`, not `resolvingScope`: this is an authoring warning about a
   * name collision the user is about to create, and a collision with a switched-off definition is
   * still worth knowing about. The "Resolves from" column makes the opposite choice, because it
   * states what resolves rather than what collides.
   */
  const trimmedNewName = newName.trim();
  const shadowedByInherited = trimmedNewName.length === 0 ? undefined : nearestDefining(trimmedNewName, inherited);
  const addRowOrigin = shadowedByInherited === undefined ? '' : `will shadow ${shadowedByInherited.label}`;

  const applyPaste = (): void => {
    if (pasteItems === undefined) {
      return;
    }
    if (onSetMany !== undefined) {
      onSetMany(pasteItems);
    } else {
      // No batch commit: safe only where the writer merges per name or serialises its round
      // trips — see `onSetMany`'s doc for why the fallback is not universally safe.
      for (const item of pasteItems) {
        onSet(item.name, item.value);
      }
    }
    setPasteItems(undefined);
    setNewName('');
    setNewValue('');
    // Not `focusNewName()` here: the dialog's own focus trap is still mounted at this point and
    // would fight a focus jump made before it unmounts. Radix already returns focus to the name
    // input on close — it was the active element when the dialog opened — once its unmount
    // completes, so there's nothing left for us to do.
  };

  const onPasteName = (event: React.ClipboardEvent<HTMLInputElement>): void => {
    const text = event.clipboardData.getData('text');
    // Strip a leading/trailing newline (a trailing one is common when a single line is copied
    // from a file) before deciding whether this is a genuine multi-line block — a single-line
    // paste is an ordinary paste, not a bulk one, even when it looks like `name=value`.
    const withoutEdgeNewlines = text.replace(/^[\r\n]+|[\r\n]+$/g, '');
    if (!/\r\n|\r|\n/.test(withoutEdgeNewlines)) {
      return;
    }
    const parsed = parsePastedVariables(text);
    if (parsed.length === 0) {
      // Nothing usable in the block — fall back to today's behaviour, a plain-text paste.
      return;
    }
    event.preventDefault();
    setPasteItems(parsed);
  };

  return (
    <div className="flex flex-col gap-2">
      <div className="overflow-hidden rounded-md border border-hairline">
        <table
          aria-label={label}
          data-testid="env-variable-table"
          className="w-full table-fixed border-collapse text-sm"
        >
          <colgroup>
            <col className="w-11" />
            <col className="w-[22%]" />
            <col />
            <col className="w-[26%]" />
            <col className="w-9" />
          </colgroup>
          <thead>
            <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-subtle uppercase">
              <th className="px-2 py-1.5 font-medium" title="Enabled">
                On
              </th>
              <th className="px-2 py-1.5 font-medium">Variable</th>
              <th className="px-2 py-1.5 font-medium">Value</th>
              <th className="px-2 py-1.5 font-medium">Resolves from</th>
              <th className="px-2 py-1.5" />
            </tr>
          </thead>
          <tbody>
            {names.length === 0 && inheritedOnlyNames.length === 0 && (
              <tr className="border-b border-hairline">
                <td colSpan={5} className="px-2 py-2 text-sm text-fg-subtle">
                  {emptyMessage}
                </td>
              </tr>
            )}
            {names.length > 0 && (
              <tr data-testid="env-variable-group" className="bg-surface-raised">
                <th
                  scope="colgroup"
                  colSpan={5}
                  className="border-b border-hairline px-2 py-1 text-left text-xs font-medium tracking-wider text-fg-subtle uppercase"
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
              <tr data-testid="env-variable-group" className="bg-surface-raised">
                <th
                  scope="colgroup"
                  colSpan={5}
                  className="border-b border-hairline px-2 py-1 text-left text-xs font-medium tracking-wider text-fg-subtle uppercase"
                >
                  Inherited · read-only
                </th>
              </tr>
            )}
            {inheritedOnlyNames.map((name) => {
              const resolved = inheritedOrigin(name, inherited);
              // `inheritedOnlyNames` was built from these same scopes, so a definer always exists.
              if (resolved === undefined) {
                return null;
              }
              const { owner, enabled, origin } = resolved;
              const ownerValue = owner.properties[name] ?? '';
              return (
                <InheritedVariableRow
                  key={name}
                  name={name}
                  value={ownerValue}
                  enabled={enabled}
                  ownerLabel={owner.label}
                  origin={origin}
                  onCommitValue={(next) => {
                    if (next !== ownerValue) {
                      onSet(name, next);
                    }
                  }}
                />
              );
            })}
            <tr data-testid="env-variable-row" className="hover:bg-surface-hover">
              <td className="px-2 py-1 text-center">
                {/* Neutral until a name exists — a variable that isn't there yet can't be disabled — then
                  checked the moment one is typed. Never interactive: there's nothing to toggle yet. */}
                <input type="checkbox" aria-label="New variable enabled" checked={trimmedNewName.length > 0} disabled />
              </td>
              <td className="px-2 py-1">
                <input
                  ref={newNameRef}
                  aria-label="New variable name"
                  data-testid="env-variable-name"
                  placeholder="name"
                  className={INPUT_CLASS}
                  value={newName}
                  onChange={(event) => {
                    setNewName(event.target.value);
                  }}
                  onPaste={onPasteName}
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
              <td className="px-2 py-1">
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
              <td className="px-2 py-1 text-xs text-fg-subtle" data-testid="env-variable-origin">
                {addRowOrigin}
              </td>
              <td className="px-2 py-1" />
            </tr>
          </tbody>
        </table>
      </div>

      {pasteItems !== undefined && (
        <ConfirmDialog
          open
          onOpenChange={(open) => {
            if (!open) {
              setPasteItems(undefined);
            }
          }}
          title="Add pasted variables?"
          description={
            <ul className="flex flex-col gap-1 text-left font-mono text-xs">
              {pasteItems.map((item) => {
                const overwritesOwn = Object.hasOwn(properties, item.name);
                const shadow = nearestDefining(item.name, inherited);
                return (
                  <li key={item.name}>
                    <span className="text-fg-default">
                      {item.name} = {item.value}
                    </span>
                    {overwritesOwn && <span className="text-status-danger"> · will overwrite the current value</span>}
                    {shadow !== undefined && <span className="text-fg-subtle"> · will shadow {shadow.label}</span>}
                  </li>
                );
              })}
            </ul>
          }
          confirmLabel={`Add ${pasteItems.length} variable${pasteItems.length === 1 ? '' : 's'}`}
          onConfirm={applyPaste}
          testId="env-variable-paste-confirm"
          confirmTestId="env-variable-paste-add"
          cancelTestId="env-variable-paste-cancel"
          onCloseAutoFocus={focusNewName}
        />
      )}

      {error !== undefined && (
        <p role="alert" className="text-sm text-status-danger">
          {error}
        </p>
      )}
    </div>
  );
}
