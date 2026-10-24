import { BooleanSetting, EnumSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/**
 * Software updates. Check on launch is off by default: Wirebench contacts GitHub Releases when the
 * user runs "Check for Updates…", or — if this is on — once shortly after the app starts, and
 * never otherwise. Nothing is ever downloaded or installed without a separate confirmation.
 * The channel picks whether a check offers pre-releases too; leaving Preview never downgrades.
 */
export function UpdatesSection({ preferences, update, locked = () => false }: SectionProps) {
  return (
    <SettingsGroup title="Updates">
      <BooleanSetting
        label="Check for updates on launch"
        setting="updates.checkOnLaunch"
        value={preferences.updates.checkOnLaunch}
        locked={locked('updates.checkOnLaunch')}
        onChange={(checkOnLaunch) => update({ updates: { checkOnLaunch } })}
        hint="Asks GitHub Releases for the latest version at startup. Downloading and installing still need your confirmation."
      />
      <EnumSetting
        label="Update channel"
        setting="updates.channel"
        value={preferences.updates.channel}
        locked={locked('updates.channel')}
        display="select"
        options={[
          { value: 'stable', label: 'Stable' },
          { value: 'preview', label: 'Preview (release candidates)' },
        ]}
        onChange={(channel) => update({ updates: { channel } })}
        hint="Preview also offers release candidates before they ship. Switching back to Stable keeps your version until a newer stable release is out."
      />
    </SettingsGroup>
  );
}
