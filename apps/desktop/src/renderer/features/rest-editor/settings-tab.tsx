/**
 * The request's own transport settings.
 *
 * Every setting is optional, and an absent one means *inherit* — never *off*. So each row shows the
 * inherited value it would fall back to, and a row the request has not set is left empty rather than
 * pre-filled with that value: a filled field would be indistinguishable from an override, and saving
 * it would freeze today's inherited value into the request.
 */
import { BooleanSetting, NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import type { RestRequestPatchWire, RestSettingsWire } from '../../../shared/wire-types.js';

/** The values a request falls back to, for the hints. */
export interface InheritedRestSettings {
  readonly timeoutMs: number;
  readonly followRedirects: boolean;
  readonly maxRedirects: number;
  readonly encodeUrl: boolean;
  readonly sendCookies: boolean;
}

export interface SettingsTabProps {
  readonly settings: RestSettingsWire;
  readonly inherited: InheritedRestSettings;
  readonly onChange: (patch: RestRequestPatchWire) => void;
}

/** The hint one inheriting row shows. */
function inheritedHint(value: string | number | boolean): string {
  return `Inherited: ${typeof value === 'boolean' ? (value ? 'on' : 'off') : String(value)}`;
}

/** The Settings tab. */
export function SettingsTab({ settings, inherited, onChange }: SettingsTabProps) {
  const patch = (next: RestSettingsWire): void => {
    onChange({ settings: next });
  };
  /** Drops a key so the setting goes back to inheriting, rather than storing a `false`/`0`. */
  const clear = (key: keyof RestSettingsWire): void => {
    const next = { ...settings };
    delete next[key];
    patch(next);
  };

  return (
    <div data-testid="rest-settings" className="overflow-auto p-3">
      <SettingsGroup title="Transport" hint="An empty field inherits; the inherited value is shown beside it.">
        <NumberSetting
          label="Timeout (ms)"
          testId="rest-setting-timeout"
          value={settings.timeoutMs}
          min={0}
          hint={inheritedHint(inherited.timeoutMs)}
          onCommit={(value) => {
            if (value === undefined) {
              clear('timeoutMs');
              return;
            }
            patch({ ...settings, timeoutMs: value });
          }}
        />
        <NumberSetting
          label="Max redirects"
          testId="rest-setting-max-redirects"
          value={settings.maxRedirects}
          min={0}
          hint={inheritedHint(inherited.maxRedirects)}
          onCommit={(value) => {
            if (value === undefined) {
              clear('maxRedirects');
              return;
            }
            patch({ ...settings, maxRedirects: value });
          }}
        />
        <BooleanSetting
          label="Follow redirects"
          testId="rest-setting-follow-redirects"
          value={settings.followRedirects ?? inherited.followRedirects}
          hint={inheritedHint(inherited.followRedirects)}
          onChange={(value) => {
            patch({ ...settings, followRedirects: value });
          }}
        />
        <BooleanSetting
          label="Keep the body on a redirect"
          testId="rest-setting-keep-body"
          value={settings.keepBodyOnRedirect ?? false}
          hint="Off follows the rule browsers use: a 301, 302 or 303 turns a POST into a GET."
          onChange={(value) => {
            patch({ ...settings, keepBodyOnRedirect: value });
          }}
        />
        <BooleanSetting
          label="Encode the URL"
          testId="rest-setting-encode-url"
          value={settings.encodeUrl ?? inherited.encodeUrl}
          hint={inheritedHint(inherited.encodeUrl)}
          onChange={(value) => {
            patch({ ...settings, encodeUrl: value });
          }}
        />
        <BooleanSetting
          label="Send cookies"
          testId="rest-setting-send-cookies"
          value={settings.sendCookies ?? inherited.sendCookies}
          hint={inheritedHint(inherited.sendCookies)}
          onChange={(value) => {
            patch({ ...settings, sendCookies: value });
          }}
        />
        <NumberSetting
          label="Max response size (bytes)"
          testId="rest-setting-max-size"
          value={settings.maxSizeBytes}
          min={0}
          hint="Empty uses the preference."
          onCommit={(value) => {
            if (value === undefined) {
              clear('maxSizeBytes');
              return;
            }
            patch({ ...settings, maxSizeBytes: value });
          }}
        />
      </SettingsGroup>

      <SettingsGroup title="Connection">
        <BooleanSetting
          label="Trust an invalid certificate"
          testId="rest-setting-trust-invalid"
          value={settings.trustInvalid ?? false}
          hint="Per request, never global. Leave it off unless you are debugging a certificate."
          onChange={(value) => {
            patch({ ...settings, trustInvalid: value });
          }}
        />
        <TextSetting
          label="Bind address"
          testId="rest-setting-bind-address"
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
