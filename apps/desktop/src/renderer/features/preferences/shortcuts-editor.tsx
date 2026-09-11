import { useState } from 'react';
import type { CommandContext } from '../../lib/commands.js';
import { chordFromEvent, chordRecordingError, formatKeybinding } from '../../lib/keybindings.js';
import { usePreferencesStore } from '../../state/preferences.js';
import type { KeymapRow } from './keymap.js';
import { keymapRows, resetValueFor } from './keymap.js';

export interface ShortcutsEditorProps {
  readonly context: CommandContext;
}

const CELL = 'px-2 py-1 text-sm';
const BUTTON =
  'h-row rounded-md border border-hairline-strong bg-surface-raised px-2 text-xs text-fg-default hover:bg-surface-hover';

/** How a row's current binding reads: the platform spelling, or an explicit "Unassigned". */
function chordLabel(row: KeymapRow, context: CommandContext): string {
  return row.chord === undefined ? 'Unassigned' : formatKeybinding(row.chord, context.platform);
}

/**
 * Preferences → Shortcuts. Every command, what runs it, and a way to change it.
 *
 * Recording a chord means capturing the next keystroke rather than typing its name: the field
 * swallows the keystroke (`preventDefault`) so recording ⌘S saves a binding instead of the
 * project. Escape leaves recording without changing anything, and Backspace unbinds the row.
 *
 * Overrides live in `preferences.shortcuts` (command id → chord, `''` = unbound), which is
 * persisted by main and read back by `lib/keybindings.ts`, so a rebind is in force on the next
 * keystroke and survives a relaunch.
 */
export function ShortcutsEditor({ context }: ShortcutsEditorProps) {
  const overrides = usePreferencesStore((state) => state.preferences.shortcuts);
  const update = usePreferencesStore((state) => state.update);
  const reset = usePreferencesStore((state) => state.reset);
  const [recording, setRecording] = useState<string | undefined>(undefined);
  // The refusal message for the row the user just tried to bind something unsafe to. Shown
  // next to that row rather than as a toast: the explanation belongs where the mistake is.
  const [refused, setRefused] = useState<{ id: string; message: string } | undefined>(undefined);

  const rows = keymapRows(overrides);

  const bind = (id: string, chord: string): void => {
    // Unbinding ('') is always safe; recording a chord is not — see `chordRecordingError`.
    const error = chord === '' ? undefined : chordRecordingError(chord);
    if (error !== undefined) {
      setRefused({ id, message: error });
      return;
    }
    setRecording(undefined);
    setRefused(undefined);
    void update({ shortcuts: { [id]: chord } });
  };

  return (
    <>
      <div className="mb-3 flex items-center justify-between gap-3">
        <p className="text-sm text-fg-subtle">
          Click a shortcut to record a new one. Escape cancels; Backspace leaves the command unbound.
        </p>
        <button
          type="button"
          data-testid="shortcuts-reset-all"
          className={BUTTON}
          onClick={() => {
            setRecording(undefined);
            void reset('shortcuts');
          }}
        >
          Reset all
        </button>
      </div>

      <table data-testid="shortcuts-table" className="w-full table-fixed border-collapse">
        <thead>
          <tr className="border-b border-hairline text-left text-xs tracking-wider text-fg-faint uppercase">
            <th scope="col" className={`${CELL} w-2/5`}>
              Command
            </th>
            <th scope="col" className={`${CELL} w-1/6`}>
              Category
            </th>
            <th scope="col" className={`${CELL} w-1/6`}>
              Default
            </th>
            <th scope="col" className={`${CELL} w-1/4`}>
              Shortcut
            </th>
            <th scope="col" className={`${CELL} w-16`}>
              <span className="sr-only">Reset</span>
            </th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={row.id} data-testid="shortcut-row" data-command={row.id} className="border-b border-hairline/50">
              <td className={`${CELL} truncate text-fg-default`} title={row.label}>
                {row.label}
                {row.conflictNote !== undefined && (
                  <span data-testid="shortcut-conflict" className="ml-2 text-xs text-status-danger">
                    {row.conflictNote}
                  </span>
                )}
                {refused?.id === row.id && (
                  <span data-testid="shortcut-refused" role="alert" className="ml-2 text-xs text-status-danger">
                    {refused.message}
                  </span>
                )}
              </td>
              <td className={`${CELL} truncate text-fg-subtle`}>{row.category}</td>
              <td className={`${CELL} truncate font-mono text-xs text-fg-subtle`}>
                {row.defaultChord === undefined ? '—' : formatKeybinding(row.defaultChord, context.platform)}
              </td>
              <td className={CELL}>
                <button
                  type="button"
                  data-testid="shortcut-chord"
                  aria-label={`Shortcut for ${row.label}`}
                  className={`${BUTTON} w-full text-left font-mono ${
                    recording === row.id ? 'ring-1 ring-accent' : ''
                  } ${row.customized ? 'text-accent' : ''}`}
                  onClick={() => {
                    setRecording(row.id);
                  }}
                  onBlur={() => {
                    setRecording((current) => (current === row.id ? undefined : current));
                  }}
                  onKeyDown={(event) => {
                    if (recording !== row.id) {
                      return;
                    }
                    event.preventDefault();
                    event.stopPropagation();
                    if (event.key === 'Escape') {
                      setRecording(undefined);
                      setRefused(undefined);
                      return;
                    }
                    if (event.key === 'Backspace' || event.key === 'Delete') {
                      bind(row.id, '');
                      return;
                    }
                    const chord = chordFromEvent(event.nativeEvent, context.platform);
                    if (chord !== undefined) {
                      bind(row.id, chord);
                    }
                  }}
                >
                  {recording === row.id ? 'Press a key…' : chordLabel(row, context)}
                </button>
              </td>
              <td className={CELL}>
                <button
                  type="button"
                  data-testid="shortcut-reset"
                  aria-label={`Reset shortcut for ${row.label}`}
                  disabled={!row.customized}
                  className={`${BUTTON} disabled:opacity-40`}
                  onClick={() => {
                    bind(row.id, resetValueFor(row));
                  }}
                >
                  Reset
                </button>
              </td>
            </tr>
          ))}
        </tbody>
      </table>
    </>
  );
}
