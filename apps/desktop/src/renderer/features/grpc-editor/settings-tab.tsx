/**
 * The request's own transport settings, on the REST tab's terms: an absent setting means
 * *inherit*, so a row the request has not set is left empty and its fallback shown beside it.
 */
import { BooleanSetting, NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import type { GrpcRequestPatchWire, GrpcSettingsWire } from '../../../shared/wire-types.js';

export interface InheritedGrpcSettings {
  readonly timeoutMs: number;
}

export interface GrpcSettingsTabProps {
  readonly settings: GrpcSettingsWire;
  readonly inherited: InheritedGrpcSettings;
  readonly onChange: (patch: GrpcRequestPatchWire) => void;
}

/** The Settings tab. */
export function GrpcSettingsTab({ settings, inherited, onChange }: GrpcSettingsTabProps) {
  const patch = (next: GrpcSettingsWire): void => {
    onChange({ settings: next });
  };
  const clear = (key: keyof GrpcSettingsWire): void => {
    const next = { ...settings };
    delete next[key];
    patch(next);
  };

  return (
    <div data-testid="grpc-settings" className="overflow-auto p-3">
      <SettingsGroup title="Call" hint="An empty field inherits; the inherited value is shown beside it.">
        <NumberSetting
          label="Deadline (ms)"
          testId="grpc-setting-timeout"
          value={settings.timeoutMs}
          min={0}
          hint={`Inherited: ${String(inherited.timeoutMs)}. Sent as grpc-timeout and enforced locally as DEADLINE_EXCEEDED.`}
          onCommit={(value) => {
            if (value === undefined) {
              clear('timeoutMs');
              return;
            }
            patch({ ...settings, timeoutMs: value });
          }}
        />
        <NumberSetting
          label="Max response size (bytes)"
          testId="grpc-setting-max-size"
          value={settings.maxSizeBytes}
          min={0}
          hint="Empty uses the preference. Messages past it are dropped and the response marked truncated."
          onCommit={(value) => {
            if (value === undefined) {
              clear('maxSizeBytes');
              return;
            }
            patch({ ...settings, maxSizeBytes: value });
          }}
        />
        <BooleanSetting
          label="Escape property values"
          testId="grpc-setting-escape"
          value={settings.escapeProperties ?? false}
          hint="Quote the value of a ${property} expanded inside the message as JSON text."
          onChange={(value) => {
            patch({ ...settings, escapeProperties: value });
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Connection">
        <BooleanSetting
          label="Trust an invalid certificate"
          testId="grpc-setting-trust-invalid"
          value={settings.trustInvalid ?? false}
          hint="Per request, never global. Leave it off unless you are debugging a certificate."
          onChange={(value) => {
            patch({ ...settings, trustInvalid: value });
          }}
        />
        <TextSetting
          label="Bind address"
          testId="grpc-setting-bind-address"
          value={settings.bindAddress ?? ''}
          monospace
          hint="The local interface to send from. Empty lets the OS choose."
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
