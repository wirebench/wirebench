import { ReadOnlySetting, SettingsGroup } from '../../../components/settings-grid.js';
import { listCommands } from '../../../lib/commands.js';
import type { CommandContext } from '../../../lib/commands.js';
import { formatKeybinding } from '../../../lib/keybindings.js';

export interface ShortcutsSectionProps {
  readonly context: CommandContext;
}

/**
 * Every command and the key that runs it, grouped by category. Read-only in this build:
 * rebinding (and therefore the `preferences.shortcuts` overrides the document already carries)
 * arrives with the keymap editor.
 */
export function ShortcutsSection({ context }: ShortcutsSectionProps) {
  const commands = listCommands(context);
  const categories = [...new Set(commands.map((command) => command.category))];

  return (
    <>
      <p className="mb-3 text-sm text-fg-subtle">Rebinding arrives with the keymap editor (Task 47).</p>
      {categories.map((category) => (
        <SettingsGroup key={category} title={category}>
          {commands
            .filter((command) => command.category === category)
            .map((command) => (
              <ReadOnlySetting
                key={command.id}
                label={command.label}
                value={
                  command.shortcut === undefined ? 'Unassigned' : formatKeybinding(command.shortcut, context.platform)
                }
              />
            ))}
        </SettingsGroup>
      ))}
    </>
  );
}
