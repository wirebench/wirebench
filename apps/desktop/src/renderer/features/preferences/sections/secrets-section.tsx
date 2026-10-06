import { NumberSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/** Preferences → Secrets: how long a value fetched from a secret manager is kept in memory. */
export function SecretsSection({ preferences, update }: SectionProps) {
  return (
    <SettingsGroup title="Secret sources">
      <NumberSetting
        label="Secret source cache (seconds)"
        value={preferences.secrets.sourceCacheSeconds}
        min={0}
        max={3600}
        testId="secrets-source-cache-seconds"
        onCommit={(sourceCacheSeconds) => {
          update({ secrets: { sourceCacheSeconds: sourceCacheSeconds ?? 300 } });
        }}
        hint="How long a value fetched from a secret manager stays in memory. 0 fetches it on every send. Values are never written to disk."
      />
    </SettingsGroup>
  );
}
