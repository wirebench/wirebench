import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import type { PreferencesWire } from '../../../../shared/wire-types.js';
import type { SectionProps } from './section-props.js';

/** HTTP transport defaults: identity, compression, connection reuse and the socket timeout. */
export function HttpSection({ preferences, update }: SectionProps) {
  const http: PreferencesWire['http'] = preferences.http;
  return (
    <>
      <SettingsGroup title="Identity">
        <TextSetting
          label="User-Agent"
          value={http.userAgent}
          onCommit={(userAgent) => update({ http: { userAgent } })}
          hint="Sent unless the request sets its own User-Agent header."
        />
      </SettingsGroup>

      <SettingsGroup title="Compression">
        <EnumSetting
          label="Request compression"
          value={http.requestCompression}
          options={[
            { value: 'none', label: 'None' },
            { value: 'gzip', label: 'gzip' },
          ]}
          onChange={(requestCompression) => update({ http: { requestCompression } })}
        />
        <BooleanSetting
          label="Accept compressed responses"
          value={http.responseCompression}
          onChange={(responseCompression) => update({ http: { responseCompression } })}
          hint="Adds Accept-Encoding: gzip, deflate."
        />
      </SettingsGroup>

      <SettingsGroup title="Connections">
        <BooleanSetting
          label="Close connections"
          value={http.closeConnections}
          onChange={(closeConnections) => update({ http: { closeConnections } })}
          hint="Sends Connection: close instead of reusing the keep-alive pool."
        />
        <NumberSetting
          label="Socket timeout (ms)"
          value={http.socketTimeoutMs}
          min={0}
          onCommit={(socketTimeoutMs) => update({ http: { socketTimeoutMs: socketTimeoutMs ?? 60000 } })}
          hint="Used when neither the request nor the project sets a timeout."
        />
        <NumberSetting
          label="Max connections"
          value={http.maxConnections}
          min={1}
          onCommit={(maxConnections) => update({ http: { maxConnections: maxConnections ?? 100 } })}
        />
        <BooleanSetting
          label="Offer HTTP/2"
          value={http.allowH2}
          testId="http-allow-h2"
          onChange={(allowH2) => update({ http: { allowH2 } })}
          hint="Advertises h2 in the TLS handshake. Off by default; most SOAP stacks speak HTTP/1.1 only."
        />
        <NumberSetting
          label="Chunking threshold (bytes)"
          value={http.chunkingThreshold}
          min={0}
          onCommit={(chunkingThreshold) => update({ http: { chunkingThreshold: chunkingThreshold ?? 0 } })}
        />
      </SettingsGroup>
    </>
  );
}
