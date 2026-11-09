/**
 * User settings → Signed-in devices (settings split spec §4). This device has no Sign out here (ruling 12): the
 * status bar's Sign out ends it properly, which in a browser tab also ends the tab's session.
 */
import { useState } from 'react';
import { Button } from '../../../components/button.js';
import { ConfirmDialog } from '../../../components/confirm-dialog.js';
import { SettingsGroup, SettingsItem } from '../../../components/settings-grid.js';
import { useUserSettingsStore } from '../../../state/user-settings.js';
import { isBrowserTab } from '../../../lib/capabilities.js';

const when = (iso: string): string => new Date(iso).toLocaleString();

export function DevicesPage() {
  const devices = useUserSettingsStore((state) => state.devices);
  const signOutDevice = useUserSettingsStore((state) => state.signOutDevice);
  const [confirming, setConfirming] = useState<{ readonly id: string; readonly name: string } | undefined>(undefined);

  return (
    <div data-testid="user-devices">
      <SettingsGroup title="Devices" hint="Signing a device out ends its session; it has to sign in again.">
        <SettingsItem>
          {devices.length === 0 ? (
            <p className="text-sm text-fg-subtle">No devices.</p>
          ) : (
            <ul className="divide-y divide-hairline">
              {devices.map((device) => (
                <li key={device.id} data-testid={`user-device-${device.id}`} className="flex items-center gap-3 py-2">
                  <div className="min-w-0 flex-1">
                    <p className="truncate text-sm text-fg-default">{device.name}</p>
                    <p className="text-xs text-fg-subtle">
                      Signed in {when(device.createdAt)} · last used {when(device.lastUsedAt)}
                    </p>
                  </div>
                  {device.current ? (
                    <span className="text-xs text-fg-subtle">{isBrowserTab() ? 'This browser' : 'This device'}</span>
                  ) : (
                    <Button
                      data-testid={`user-device-sign-out-${device.id}`}
                      aria-label={`Sign out ${device.name}`}
                      onClick={() => {
                        setConfirming({ id: device.id, name: device.name });
                      }}
                    >
                      Sign out
                    </Button>
                  )}
                </li>
              ))}
            </ul>
          )}
        </SettingsItem>
      </SettingsGroup>
      <ConfirmDialog
        open={confirming !== undefined}
        onOpenChange={(open) => {
          if (!open) setConfirming(undefined);
        }}
        title="Sign out this device?"
        description={`“${confirming?.name ?? ''}” will have to sign in again.`}
        confirmLabel="Sign out"
        destructive
        onConfirm={() => {
          if (confirming !== undefined) void signOutDevice(confirming.id);
          setConfirming(undefined);
        }}
      />
    </div>
  );
}
