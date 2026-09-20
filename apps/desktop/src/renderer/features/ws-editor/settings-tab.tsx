/**
 * The request's own transport settings, on the gRPC tab's terms: an absent setting means
 * *inherit*, so a row the request has not set is left empty. Trusting an invalid certificate
 * carries the same red badge it does everywhere else, for as long as it is on.
 */
import { BooleanSetting, NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import { TrustInvalidBadge } from '../../components/trust-invalid-badge.js';
import type { WsRequestPatchWire, WsSettingsWire } from '../../../shared/wire-types.js';

export interface WsSettingsTabProps {
  readonly settings: WsSettingsWire;
  /** The handshake timeout the request inherits when it sets none. */
  readonly inheritedTimeoutMs: number;
  readonly onChange: (patch: WsRequestPatchWire) => void;
}

/** The Settings tab. */
export function WsSettingsTab({ settings, inheritedTimeoutMs, onChange }: WsSettingsTabProps) {
  const patch = (next: WsSettingsWire): void => {
    onChange({ settings: next });
  };
  const clear = (key: keyof WsSettingsWire): void => {
    const next = { ...settings };
    delete next[key];
    patch(next);
  };

  return (
    <div data-testid="ws-settings" className="overflow-auto p-3">
      <SettingsGroup title="Session" hint="An empty field inherits; the inherited value is shown beside it.">
        <NumberSetting
          label="Handshake timeout (ms)"
          testId="ws-setting-handshake-timeout"
          value={settings.handshakeTimeoutMs}
          min={0}
          hint={`Inherited: ${String(inheritedTimeoutMs)}. The connection fails if the upgrade takes longer.`}
          onCommit={(value) => {
            if (value === undefined) {
              clear('handshakeTimeoutMs');
              return;
            }
            patch({ ...settings, handshakeTimeoutMs: value });
          }}
        />
        <NumberSetting
          label="Max message size (bytes)"
          testId="ws-setting-max-message"
          value={settings.maxMessageBytes}
          min={0}
          hint="Empty uses the preference. A received message larger than this closes the session."
          onCommit={(value) => {
            if (value === undefined) {
              clear('maxMessageBytes');
              return;
            }
            patch({ ...settings, maxMessageBytes: value });
          }}
        />
        <BooleanSetting
          label="Escape property values"
          testId="ws-setting-escape"
          value={settings.escapeProperties ?? false}
          hint="Quote the value of a ${property} expanded inside a message as JSON text."
          onChange={(value) => {
            patch({ ...settings, escapeProperties: value });
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Connection">
        <BooleanSetting
          label="Trust an invalid certificate"
          testId="ws-setting-trust-invalid"
          value={settings.trustInvalid ?? false}
          hint="Per request, never global. Leave it off unless you are debugging a certificate."
          onChange={(value) => {
            patch({ ...settings, trustInvalid: value });
          }}
        />
        {settings.trustInvalid === true && (
          <div className="py-1">
            <TrustInvalidBadge testId="ws-trust-invalid-badge" />
          </div>
        )}
        <TextSetting
          label="Bind address"
          testId="ws-setting-bind-address"
          value={settings.bindAddress ?? ''}
          monospace
          hint="The local interface to connect from. Empty lets the OS choose."
          onCommit={(value) => {
            if (value === '') {
              clear('bindAddress');
              return;
            }
            patch({ ...settings, bindAddress: value });
          }}
        />
      </SettingsGroup>
    </div>
  );
}
