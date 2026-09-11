import { BooleanSetting, EnumSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/** WS-I Basic Profile validation preferences. */
export function WsiSection({ preferences, update }: SectionProps) {
  return (
    <SettingsGroup title="WS-I">
      <EnumSetting
        label="Profile"
        value={preferences.wsi.profile}
        options={[{ value: 'BP1.1', label: 'Basic Profile 1.1' }]}
        onChange={() => undefined}
      />
      <BooleanSetting
        label="Verbose report"
        value={preferences.wsi.verbose}
        onChange={(verbose) => update({ wsi: { verbose } })}
      />
    </SettingsGroup>
  );
}
