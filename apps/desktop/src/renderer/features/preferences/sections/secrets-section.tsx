import { NumberSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';

/** Preferences → Secrets: how long a value fetched from a secret manager is kept in memory. */
export function SecretsSection({ preferences, update }: SectionProps) {
  return (
    <SettingsGroup title="Secret sources">
      <NumberSetting
        label="Secret source cache"
        setting="secrets.sourceCacheSeconds"
        value={preferences.secrets.sourceCacheSeconds}
        {...PREFERENCE_LIMITS['secrets.sourceCacheSeconds']}
        unit="s"
        placeholder={String(DEFAULT_PREFERENCES_WIRE.secrets.sourceCacheSeconds)}
        testId="secrets-source-cache-seconds"
        onCommit={(sourceCacheSeconds) => {
          update({
            secrets: { sourceCacheSeconds: sourceCacheSeconds ?? DEFAULT_PREFERENCES_WIRE.secrets.sourceCacheSeconds },
          });
        }}
        hint="How long a value fetched from a secret manager stays in memory. 0 fetches it on every send. Values are never written to disk."
      />
    </SettingsGroup>
  );
}
