/**
 * The Preferences → Network surfaces: Proxy and SSL/TLS.
 *
 * Both are live — every field here is read by the main process on the next send (see
 * `ProjectService.proxyFor` and `tlsFor`) — which is why they are no longer in
 * `connection-sections.tsx` alongside the still-informational WS-I group.
 *
 * Two rules shape the UI. The proxy password is never a value: it goes through `SecretField`,
 * which stores it in the OS keychain and hands back a `secretRef`. And there is no global
 * "trust all certificates" — the checkbox exists only to say so, permanently disabled, with
 * the per-endpoint opt-in named as the alternative.
 */

import { useState } from 'react';
import { Button } from '../../components/button.js';
import { SecretField } from '../../components/secret-field.js';
import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../components/settings-grid.js';
import { ipc } from '../../state/ipc-client.js';
import { useProjectStore } from '../../state/project.js';
import type { SectionProps } from './sections/section-props.js';

/** Proxy preferences, applied to every send. */
export function ProxySection({ preferences, update }: SectionProps) {
  const proxy = preferences.proxy;
  const manual = proxy.mode === 'manual';
  return (
    <SettingsGroup
      title="Proxy"
      hint="Applied to every send. Excluded hosts always go direct, including under a system proxy."
    >
      <EnumSetting
        label="Mode"
        value={proxy.mode}
        testId="proxy-mode"
        options={[
          { value: 'none', label: 'No proxy' },
          { value: 'system', label: 'System proxy' },
          { value: 'manual', label: 'Manual' },
        ]}
        onChange={(mode) => update({ proxy: { mode } })}
      />
      <TextSetting
        label="Host"
        value={proxy.host ?? ''}
        readOnly={!manual}
        testId="proxy-host"
        onCommit={(host) => update({ proxy: { host } })}
      />
      <NumberSetting
        label="Port"
        value={proxy.port}
        min={1}
        testId="proxy-port"
        onCommit={(port) => update({ proxy: { port: port ?? undefined } })}
      />
      <TextSetting
        label="Username"
        value={proxy.username ?? ''}
        readOnly={!manual}
        testId="proxy-username"
        onCommit={(username) => update({ proxy: { username } })}
      />
      <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-x-3 py-1">
        <span className="text-sm text-fg-muted">Password</span>
        <SecretField
          label="Proxy password"
          value={proxy.passwordRef}
          disabled={!manual}
          onChange={(passwordRef) => update({ proxy: { passwordRef: passwordRef ?? '' } })}
        />
      </div>
      <TextSetting
        label="Excludes"
        value={proxy.excludes.join(', ')}
        testId="proxy-excludes"
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
export function SslSection({ preferences, update }: SectionProps) {
  const ssl = preferences.ssl;
  const keystores = useProjectStore((state) => state.keystores);
  const [picking, setPicking] = useState(false);

  async function pickBundle(): Promise<void> {
    setPicking(true);
    try {
      const result = await ipc().dialogs.openFile({
        title: 'Choose a CA bundle',
        filters: [
          { name: 'PEM certificates', extensions: ['pem', 'crt', 'cer'] },
          { name: 'All files', extensions: ['*'] },
        ],
      });
      if (result.ok && result.value.path !== undefined) {
        update({ ssl: { caBundlePath: result.value.path } });
      }
    } finally {
      setPicking(false);
    }
  }

  return (
    <SettingsGroup title="SSL / TLS">
      <EnumSetting
        label="Minimum version"
        value={ssl.minVersion}
        testId="ssl-min-version"
        options={[
          { value: 'TLSv1.2', label: 'TLS 1.2' },
          { value: 'TLSv1.3', label: 'TLS 1.3' },
        ]}
        onChange={(minVersion) => update({ ssl: { minVersion } })}
      />
      <TextSetting
        label="CA bundle"
        value={ssl.caBundlePath ?? ''}
        monospace
        testId="ssl-ca-bundle"
        hint="A PEM file of extra trust anchors. Added to the system store; nothing is replaced."
        onCommit={(caBundlePath) => update({ ssl: { caBundlePath } })}
      />
      <div className="grid grid-cols-[minmax(8rem,14rem)_1fr] items-center gap-x-3 py-1">
        <span />
        <div className="flex gap-2">
          <Button
            variant="secondary"
            disabled={picking}
            data-testid="ssl-ca-bundle-browse"
            onClick={() => {
              void pickBundle();
            }}
          >
            Browse…
          </Button>
          {ssl.caBundlePath !== undefined && ssl.caBundlePath.length > 0 && (
            <Button
              variant="secondary"
              data-testid="ssl-ca-bundle-clear"
              onClick={() => update({ ssl: { caBundlePath: '' } })}
            >
              Clear
            </Button>
          )}
        </div>
      </div>
      <EnumSetting
        label="Client keystore"
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
