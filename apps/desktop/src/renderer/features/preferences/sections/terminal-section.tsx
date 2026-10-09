import { BooleanSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/** Preferences → Terminal: what the SSH terminal does with a paste and with a selection. */
export function TerminalSection({ preferences, update }: SectionProps) {
  const terminal = preferences.terminal;
  return (
    <SettingsGroup title="Clipboard">
      <BooleanSetting
        label="Confirm multi-line paste"
        value={terminal.confirmMultilinePaste}
        onChange={(confirmMultilinePaste) => {
          update({ terminal: { confirmMultilinePaste } });
        }}
        hint="Ask before text with more than one line reaches the shell: a pasted script runs line by line."
      />
      <BooleanSetting
        label="Copy on select"
        value={terminal.copyOnSelect}
        onChange={(copyOnSelect) => {
          update({ terminal: { copyOnSelect } });
        }}
        hint="Put the selection on the clipboard as soon as it is made."
      />
    </SettingsGroup>
  );
}
