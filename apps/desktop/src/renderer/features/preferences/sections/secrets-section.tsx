import { useEffect, useState } from 'react';
import { BooleanSetting, NumberSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';
import { ipc } from '../../../state/ipc-client.js';

/**
 * Preferences → Secrets: how long a value fetched from a secret manager is kept in memory, and the app lock
 * (#428), which main turns on only after one prompt the person passes (`appLock.set`).
 */
export function SecretsSection({ preferences, update, locked = () => false }: SectionProps) {
  const [support, setSupport] = useState<{ supported: boolean; reason?: string | undefined }>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  useEffect(() => {
    let live = true;
    void ipc()
      .appLock.status(undefined)
      .then((result) => {
        if (live) setSupport(result.ok ? result.value : { supported: false, reason: result.error.message });
      });
    return () => {
      live = false;
    };
  }, []);

  const setAppLock = async (enabled: boolean): Promise<void> => {
    setBusy(true);
    setError(undefined);
    // Turning it on asks for biometrics or the password first; the new preferences arrive as a broadcast.
    const result = await ipc().appLock.set({ enabled });
    setBusy(false);
    if (!result.ok)
      setError(enabled ? 'The app lock was not turned on: the prompt was not passed.' : result.error.message);
  };

  return (
    <>
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
              secrets: {
                sourceCacheSeconds: sourceCacheSeconds ?? DEFAULT_PREFERENCES_WIRE.secrets.sourceCacheSeconds,
              },
            });
          }}
          hint="How long a value fetched from a secret manager stays in memory. 0 fetches it on every send. Values are never written to disk."
        />
      </SettingsGroup>
      <SettingsGroup title="App lock">
        <BooleanSetting
          label="Ask before SSH secrets are used"
          value={preferences.secrets.appLock}
          disabled={busy || support?.supported !== true}
          locked={locked('secrets.appLock')}
          testId="secrets-app-lock"
          onChange={(enabled) => {
            void setAppLock(enabled);
          }}
          hint="Asks for biometrics or your password before the first SSH secret is used after launch, after the idle time below, and after the screen locks. Turning it on asks once now."
          note={
            support?.supported === false && (
              <p data-testid="secrets-app-lock-unavailable">
                App lock needs Touch ID, Windows Hello or the system password prompt.
                {/* Main adds a reason only when it says more than that, such as why the prompt failed here. */}
                {support.reason !== undefined && ` ${support.reason.replace(/\.?$/, '.')}`}
              </p>
            )
          }
        />
        {error !== undefined && (
          <p role="alert" data-testid="secrets-app-lock-error" className="px-3 text-sm text-status-danger">
            {error}
          </p>
        )}
        <NumberSetting
          label="Lock again after idle"
          setting="secrets.appLockIdleMinutes"
          value={preferences.secrets.appLockIdleMinutes}
          {...PREFERENCE_LIMITS['secrets.appLockIdleMinutes']}
          unit="min"
          placeholder={String(DEFAULT_PREFERENCES_WIRE.secrets.appLockIdleMinutes)}
          testId="secrets-app-lock-idle"
          // Nothing to tune while the lock is off or this computer cannot ask.
          disabled={!preferences.secrets.appLock || support?.supported !== true}
          locked={locked('secrets.appLockIdleMinutes')}
          onCommit={(appLockIdleMinutes) => {
            update({
              secrets: {
                appLockIdleMinutes: appLockIdleMinutes ?? DEFAULT_PREFERENCES_WIRE.secrets.appLockIdleMinutes,
              },
            });
          }}
          hint="Minutes without keyboard or mouse input on this computer after which SSH secrets need the prompt again."
        />
      </SettingsGroup>
    </>
  );
}
