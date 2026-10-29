/**
 * The Preferences → Network surfaces: Proxy and SSL/TLS.
 *
 * Both are live — every field here is read by the main process on the next send (see
 * `ProjectHost.proxyFor` and `tlsFor`) — which is why they are no longer in
 * `connection-sections.tsx` alongside the still-informational WS-I group.
 *
 * Three rules shape the UI. The proxy password is never a value: it goes through `SecretField`,
 * which stores it in the OS keychain and hands back a `secretRef`. There is no global "trust
 * all certificates" — the checkbox exists only to say so, permanently disabled, with the
 * per-endpoint opt-in named as the alternative. And the CA bundle path is read-only here:
 * main reads that file on every send, so it is set only by `ssl.pickCaBundle`, which runs a
 * native picker in main and persists what the user actually chose.
 */

import { useState } from 'react';
import { Button } from '../../components/button.js';
import { SecretField } from '../../components/secret-field.js';
import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  SettingsRow,
  TextSetting,
} from '../../components/settings-grid.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { SectionProps } from './sections/section-props.js';
import { PREFERENCE_LIMITS } from '../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../state/preferences-defaults.js';
import { proxyHostProblem } from './validators.js';
import { hasCapability, secretKeptHint } from '../../lib/capabilities.js';

/** Proxy preferences, applied to every send. */
export function ProxySection({ preferences, update, locked = () => false }: SectionProps) {
  const proxy = preferences.proxy;
  const manual = proxy.mode === 'manual';
  return (
    <SettingsGroup
      title="Proxy"
      hint="Applied to every send. Excluded hosts always go direct, including under a system proxy."
    >
      <EnumSetting
        label="Mode"
        setting="proxy.mode"
        value={proxy.mode}
        testId="proxy-mode"
        locked={locked('proxy.mode')}
        options={[
          { value: 'none', label: 'No proxy' },
          { value: 'system', label: 'System proxy' },
          { value: 'manual', label: 'Manual' },
        ]}
        onChange={(mode) => update({ proxy: { mode } })}
      />
      <TextSetting
        label="Host"
        setting="proxy.host"
        value={proxy.host ?? ''}
        readOnly={!manual}
        trim
        validate={proxyHostProblem}
        testId="proxy-host"
        locked={locked('proxy.host')}
        onCommit={(host) => update({ proxy: { host } })}
      />
      <NumberSetting
        label="Port"
        setting="proxy.port"
        value={proxy.port}
        {...PREFERENCE_LIMITS['proxy.port']}
        readOnly={!manual}
        testId="proxy-port"
        locked={locked('proxy.port')}
        // `null` clears the port in main; `undefined` would leave it as it was.
        onCommit={(port) => update({ proxy: { port: port ?? null } })}
      />
      <TextSetting
        label="Username"
        setting="proxy.username"
        value={proxy.username ?? ''}
        readOnly={!manual}
        trim
        testId="proxy-username"
        locked={locked('proxy.username')}
        onCommit={(username) => update({ proxy: { username } })}
      />
      <SettingsRow label="Password" hint={secretKeptHint('Kept in the OS keychain, never in the preferences file.')}>
        <div className="w-64">
          <SecretField
            label="Proxy password"
            value={proxy.passwordRef}
            disabled={!manual}
            onChange={(passwordRef) => update({ proxy: { passwordRef: passwordRef ?? '' } })}
          />
        </div>
      </SettingsRow>
      {/*
        Excludes stay editable in every mode, unlike the fields above: `resolveProxyFor` checks
        them before it consults the system proxy too, so they matter under "System proxy" as much
        as under "Manual" (the group hint says so).
      */}
      <TextSetting
        label="Excludes"
        setting="proxy.excludes"
        trim
        value={proxy.excludes.join(', ')}
        testId="proxy-excludes"
        locked={locked('proxy.excludes')}
        hint="Comma-separated: host names, *.wildcards, IPv4 CIDR blocks (10.0.0.0/8) or localhost. No port numbers."
        onCommit={(value) =>
          update({
            proxy: {
              excludes: value
                .split(',')
                .map((entry) => entry.trim())
                .filter((entry) => entry.length > 0),
            },
          })
        }
      />
    </SettingsGroup>
  );
}

/** TLS preferences, folded into every send's TLS options by the main process. */
export function SslSection({ preferences, update, locked = () => false }: SectionProps) {
  const ssl = preferences.ssl;
  const bundleLocked = locked('ssl.caBundlePath');
  const keystores = useProjectStore((state) => state.keystores);
  const [picking, setPicking] = useState(false);

  async function pickBundle(): Promise<void> {
    setPicking(true);
    try {
      // Main runs the dialog, records the pick and persists the path itself; the answer arrives
      // as a `preferences.changed` broadcast. The renderer never names the path — see
      // `main/ipc/ssl.ts`.
      await ipc().ssl.pickCaBundle({});
    } finally {
      setPicking(false);
    }
  }

  return (
    <SettingsGroup title="SSL / TLS">
      <EnumSetting
        label="Minimum version"
        setting="ssl.minVersion"
        value={ssl.minVersion}
        testId="ssl-min-version"
        locked={locked('ssl.minVersion')}
        options={[
          { value: 'TLSv1.2', label: 'TLS 1.2' },
          { value: 'TLSv1.3', label: 'TLS 1.3' },
        ]}
        onChange={(minVersion) => update({ ssl: { minVersion } })}
      />
      {/* A PEM file on the machine, picked in a native dialog: nothing to choose on a host without either. */}
      {hasCapability('files') && hasCapability('dialogs') && (
        <>
          <TextSetting
            label="CA bundle"
            setting="ssl.caBundlePath"
            value={ssl.caBundlePath ?? ''}
            monospace
            readOnly
            testId="ssl-ca-bundle"
            locked={bundleLocked}
            hint="A PEM file of extra trust anchors, chosen with Browse…. Added to the system store; nothing is replaced."
            onCommit={() => undefined}
          />
          <SettingsRow label="Choose a CA bundle" locked={bundleLocked}>
            <div className="flex gap-2">
              <Button
                variant="secondary"
                disabled={picking || bundleLocked}
                data-testid="ssl-ca-bundle-browse"
                onClick={() => {
                  void pickBundle();
                }}
              >
                Browse…
              </Button>
              {!bundleLocked && ssl.caBundlePath !== undefined && ssl.caBundlePath.length > 0 && (
                <Button
                  variant="secondary"
                  data-testid="ssl-ca-bundle-clear"
                  onClick={() => {
                    void ipc().ssl.clearCaBundle({});
                  }}
                >
                  Clear
                </Button>
              )}
            </div>
          </SettingsRow>
        </>
      )}
      <EnumSetting
        display="select"
        label="Client keystore"
        setting="ssl.clientKeystoreRef"
        value={ssl.clientKeystoreRef ?? ''}
        testId="ssl-client-keystore"
        hint="Presented when a request selects no keystore of its own. The request always wins."
        options={[
          { value: '', label: 'None' },
          ...keystores.map((keystore) => ({ value: keystore.id, label: keystore.name })),
          ...(ssl.clientKeystoreRef !== undefined &&
          ssl.clientKeystoreRef.length > 0 &&
          !keystores.some((keystore) => keystore.id === ssl.clientKeystoreRef)
            ? [{ value: ssl.clientKeystoreRef, label: `${ssl.clientKeystoreRef} (missing)` }]
            : []),
        ]}
        onChange={(clientKeystoreRef) => update({ ssl: { clientKeystoreRef } })}
      />
      <NumberSetting
        label="Expiry warning"
        setting="ssl.expiryWarningDays"
        value={ssl.expiryWarningDays}
        {...PREFERENCE_LIMITS['ssl.expiryWarningDays']}
        unit="days"
        placeholder={String(DEFAULT_PREFERENCES_WIRE.ssl.expiryWarningDays)}
        testId="ssl-expiry-warning-days"
        hint="Warn in Problems this many days before a keystore, CA bundle or endpoint certificate expires. 0 warns only once expired."
        onCommit={(expiryWarningDays) =>
          update({ ssl: { expiryWarningDays: expiryWarningDays ?? DEFAULT_PREFERENCES_WIRE.ssl.expiryWarningDays } })
        }
      />
      <BooleanSetting
        label="Trust all certificates"
        value={ssl.trustAll}
        disabled
        onChange={() => undefined}
        hint="Never available globally. Turn on “Trust invalid certificates” on a single endpoint instead."
      />
    </SettingsGroup>
  );
}
