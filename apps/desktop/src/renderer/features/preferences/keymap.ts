/**
 * The model behind the Shortcuts editor: what every command is bound to right now, what it was
 * bound to out of the box, and which rows collide.
 *
 * Pure over an explicit override map so the table, the conflict warning and the reset buttons
 * can all be tested without rendering anything.
 */

import type { CommandDefinition } from '../../../shared/commands.js';
import { COMMAND_WHEN_SCOPES, whenScopesOverlap } from '../../../shared/commands.js';
import type { CommandContext } from '../../lib/commands.js';
import { listAllCommands } from '../../lib/commands.js';
import { parseKeybinding } from '../../lib/keybindings.js';

/** One row of the Shortcuts table. */
export interface KeymapRow {
  readonly id: string;
  readonly label: string;
  readonly category: string;
  /** The chord the command ships with, or `undefined` when it ships unbound. */
  readonly defaultChord: string | undefined;
  /** The chord in force, after the user's override; `undefined` means unbound. */
  readonly chord: string | undefined;
  /** True when the user has set this row to something other than its default. */
  readonly customized: boolean;
  /** Other command labels bound to the very same chord in an overlapping scope; empty when
   * there is no clash. Commands whose `when` conditions can never both hold are not a clash. */
  readonly conflictsWith: readonly string[];
  /** The warning to show, naming the other commands and which one the dispatcher picks; only
   * set when {@link conflictsWith} is non-empty. */
  readonly conflictNote?: string;
}

/** `'Mod+Shift+F'` reduced to a comparable identity, so `Shift+Mod+f` collides with it. */
export function chordIdentity(chord: string): string {
  const parsed = parseKeybinding(chord);
  return `${parsed.key}|${String(parsed.mod)}|${String(parsed.shift)}|${String(parsed.alt)}`;
}

function effective(definition: CommandDefinition<CommandContext>, overrides: Readonly<Record<string, string>>) {
  const override = overrides[definition.id];
  if (override === undefined) {
    return definition.shortcut;
  }
  return override === '' ? undefined : override;
}

/**
 * The warning for one clash: who else holds the chord, and who actually gets the keystroke.
 *
 * The winner is the first of the clashing commands in the dispatcher's own order —
 * `lib/keybindings.ts` walks `listCommands`, which is sorted by (category, label), and runs the
 * first match — so the note can state the outcome rather than just the collision. When the
 * winner is gated, its condition is spelled out, because outside that condition the loser is
 * the one that runs.
 */
function conflictNoteFor(
  row: CommandDefinition<CommandContext>,
  clashing: readonly CommandDefinition<CommandContext>[],
): string {
  const others = clashing.filter((command) => command.id !== row.id).map((command) => command.label);
  const winner = clashing[0];
  if (winner === undefined) {
    return `Also bound to ${others.join(', ')}`;
  }
  const scope = winner.whenScope === undefined ? undefined : COMMAND_WHEN_SCOPES[winner.whenScope];
  const wins = scope === undefined ? `${winner.label} wins` : `${winner.label} wins while ${scope}`;
  return `Also bound to ${others.join(', ')} (${wins})`;
}

/**
 * Every registered command as a table row, in the registry's own (category, label) order.
 *
 * Conflicts are computed across the whole table rather than per row, so both sides of a clash
 * are flagged — a warning on only one of them would read as if the other were fine.
 *
 * A shared chord is only a conflict when the two commands can be live at the same moment: an
 * Explorer action gated on a selected interface and an editor action gated on a request tab
 * never compete, and warning about them would train the user to ignore the warning. See
 * `whenScopesOverlap`.
 *
 * @param overrides - `preferences.shortcuts`; `''` means the user unbound the command.
 */
export function keymapRows(overrides: Readonly<Record<string, string>>): readonly KeymapRow[] {
  const commands = listAllCommands();
  const byIdentity = new Map<string, CommandDefinition<CommandContext>[]>();

  for (const command of commands) {
    const chord = effective(command, overrides);
    if (chord === undefined) {
      continue;
    }
    let identity: string;
    try {
      identity = chordIdentity(chord);
    } catch {
      continue;
    }
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), command]);
  }

  return commands.map((command) => {
    const chord = effective(command, overrides);
    const sharing = chord === undefined ? [] : (byIdentity.get(safeIdentity(chord)) ?? []);
    // `listAllCommands` is already in dispatch order, and this preserves it, so `clashing[0]`
    // is the command the keystroke actually reaches.
    const clashing = sharing.filter((other) => whenScopesOverlap(command.whenScope, other.whenScope));
    const conflictsWith = clashing.filter((other) => other.id !== command.id).map((other) => other.label);
    return {
      id: command.id,
      label: command.label,
      category: command.category,
      defaultChord: command.shortcut,
      chord,
      customized: overrides[command.id] !== undefined && chord !== command.shortcut,
      conflictsWith,
      ...(conflictsWith.length > 0 ? { conflictNote: conflictNoteFor(command, clashing) } : {}),
    };
  });
}

/** {@link chordIdentity} that answers with the raw chord rather than throwing on a bad one. */
function safeIdentity(chord: string): string {
  try {
    return chordIdentity(chord);
  } catch {
    return chord;
  }
}

/**
 * The override value that resets `row` to its default. Preference patches merge rather than
 * delete, so a reset restates the shipped chord (or `''` for a command that ships unbound)
 * instead of removing the key — "Reset all" is what clears the map, through
 * `preferences.reset('shortcuts')`.
 */
export function resetValueFor(row: KeymapRow): string {
  return row.defaultChord ?? '';
}
