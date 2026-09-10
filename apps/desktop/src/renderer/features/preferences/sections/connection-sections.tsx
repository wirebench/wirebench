import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/** Shown on the sections whose fields are stored but not yet consulted by a send. */
const LATER = 'Stored now; applied when connection settings are wired up (Task 49).';

/** Proxy preferences. Editable and persisted; the send path does not read them yet. */
export function ProxySection({ preferences, update }: SectionProps) {
  const proxy = preferences.proxy;
  const manual = proxy.mode === 'manual';
  return (
    <SettingsGroup title="Proxy" hint={LATER}>
      <EnumSetting
        label="Mode"
        value={proxy.mode}
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
        onCommit={(host) => update({ proxy: { host } })}
      />
      <NumberSetting
        label="Port"
        value={proxy.port}
        min={1}
        onCommit={(port) => update({ proxy: { port: port ?? undefined } })}
      />
      <TextSetting
        label="Username"
        value={proxy.username ?? ''}
        readOnly={!manual}
        onCommit={(username) => update({ proxy: { username } })}
      />
      <TextSetting
        label="Excludes"
        value={proxy.excludes.join(', ')}
        hint="Comma-separated hosts that bypass the proxy."
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

/** TLS preferences. Editable and persisted; the send path does not read them yet. */
export function SslSection({ preferences, update }: SectionProps) {
  const ssl = preferences.ssl;
  return (
    <SettingsGroup title="SSL / TLS" hint={LATER}>
      <EnumSetting
        label="Minimum version"
        value={ssl.minVersion}
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
        onCommit={(caBundlePath) => update({ ssl: { caBundlePath } })}
      />
      <BooleanSetting
        label="Trust all certificates"
        value={ssl.trustAll}
        disabled
        onChange={() => undefined}
        hint="Never available globally; certificate trust is opted into per endpoint."
      />
    </SettingsGroup>
  );
}

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
