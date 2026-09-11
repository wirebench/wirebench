import { BooleanSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/**
 * Software updates. One setting, off by default: Wirebench contacts GitHub Releases when the
 * user runs "Check for Updates…", or — if this is on — once shortly after the app starts, and
 * never otherwise. Nothing is ever downloaded or installed without a separate confirmation.
 */
export function UpdatesSection({ preferences, update }: SectionProps) {
  return (
    <SettingsGroup title="Updates">
      <BooleanSetting
        label="Check for updates on launch"
        value={preferences.updates.checkOnLaunch}
        onChange={(checkOnLaunch) => update({ updates: { checkOnLaunch } })}
        hint="Asks GitHub Releases for the latest version at startup. Downloading and installing still need your confirmation."
      />
    </SettingsGroup>
  );
}
