import { REST_ACCEPT_ENCODING, SOAP_ACCEPT_ENCODING } from '@wirebench/engine/rest';
import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import type { PreferencesWire } from '@shared/wire-base.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';
import { headerValueProblem } from '../validators.js';
import type { SectionProps } from './section-props.js';

/** HTTP transport defaults: identity, compression, connection reuse and the socket timeout. */
export function HttpSection({ preferences, update }: SectionProps) {
  const http: PreferencesWire['http'] = preferences.http;
  return (
    <>
      <SettingsGroup title="Identity">
        <TextSetting
          label="User-Agent"
          setting="http.userAgent"
          value={http.userAgent}
          trim
          validate={headerValueProblem}
          onCommit={(userAgent) => update({ http: { userAgent } })}
          hint="Sent unless the request sets its own User-Agent header. The default, Wirebench/<version>, follows the app's version."
        />
      </SettingsGroup>

      <SettingsGroup title="Compression">
        <EnumSetting
          label="Request compression"
          setting="http.requestCompression"
          value={http.requestCompression}
          options={[
            { value: 'none', label: 'None' },
            { value: 'gzip', label: 'gzip' },
          ]}
          onChange={(requestCompression) => update({ http: { requestCompression } })}
        />
        <BooleanSetting
          label="Accept compressed responses"
          setting="http.responseCompression"
          value={http.responseCompression}
          onChange={(responseCompression) => update({ http: { responseCompression } })}
          hint={`Adds Accept-Encoding: ${REST_ACCEPT_ENCODING} to REST requests and ${SOAP_ACCEPT_ENCODING} to SOAP requests.`}
        />
      </SettingsGroup>

      <SettingsGroup title="Connections">
        <BooleanSetting
          label="Close connections"
          setting="http.closeConnections"
          value={http.closeConnections}
          onChange={(closeConnections) => update({ http: { closeConnections } })}
          hint="Sends Connection: close instead of reusing the keep-alive pool."
        />
        <NumberSetting
          label="Socket timeout"
          setting="http.socketTimeoutMs"
          value={http.socketTimeoutMs}
          {...PREFERENCE_LIMITS['http.socketTimeoutMs']}
          unit="ms"
          placeholder={String(DEFAULT_PREFERENCES_WIRE.http.socketTimeoutMs)}
          onCommit={(socketTimeoutMs) =>
            update({ http: { socketTimeoutMs: socketTimeoutMs ?? DEFAULT_PREFERENCES_WIRE.http.socketTimeoutMs } })
          }
          hint="Used when neither the request nor the project sets a timeout."
        />
        <NumberSetting
          label="Max connections"
          setting="http.maxConnections"
          value={http.maxConnections}
          {...PREFERENCE_LIMITS['http.maxConnections']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.http.maxConnections)}
          onCommit={(maxConnections) =>
            update({ http: { maxConnections: maxConnections ?? DEFAULT_PREFERENCES_WIRE.http.maxConnections } })
          }
        />
        <BooleanSetting
          label="Offer HTTP/2"
          setting="http.offerH2"
          value={http.offerH2}
          testId="http-offer-h2"
          onChange={(offerH2) => update({ http: { offerH2 } })}
          hint="Advertises h2 in the TLS handshake; the server picks, so HTTP/1.1-only stacks stay on 1.1. NTLM and Kerberos always use HTTP/1.1. Turn off for a server that asks for a client certificate mid-connection."
        />
        <NumberSetting
          label="Chunking threshold"
          setting="http.chunkingThreshold"
          value={http.chunkingThreshold}
          {...PREFERENCE_LIMITS['http.chunkingThreshold']}
          unit="bytes"
          placeholder={String(DEFAULT_PREFERENCES_WIRE.http.chunkingThreshold)}
          onCommit={(chunkingThreshold) => update({ http: { chunkingThreshold: chunkingThreshold ?? 0 } })}
        />
      </SettingsGroup>
    </>
  );
}
