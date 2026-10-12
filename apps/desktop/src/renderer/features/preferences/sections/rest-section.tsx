/**
 * REST defaults: what a request inherits when it sets nothing of its own.
 *
 * Every value here is a *floor*, not a lock — a request's own Settings tab overrides any of them —
 * which is why each hint says what it applies to rather than what it forbids.
 */
import { NumberSetting, SettingsGroup, TextSetting, BooleanSetting } from '../../../components/settings-grid.js';
import type { PreferencesWire } from '../../../../shared/wire-base.js';
import type { SectionProps } from './section-props.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';
import { headerValueProblem } from '../validators.js';

const MIB = 1024 * 1024;

/** Bytes as mebibytes to two decimals, for the pretty-print threshold's field. */
function toMib(bytes: number): number {
  return Math.round((bytes / MIB) * 100) / 100;
}

/**
 * The pretty-print threshold is stored in bytes but edited in MiB, decimals allowed: 0.01 MiB
 * (about 10 KiB) up to the stored maximum of 1 GiB.
 */
const PRETTY_MIB = { min: 0.01, max: PREFERENCE_LIMITS['rest.prettyPrintMaxBytes'].max / MIB, integer: false } as const;

/** The REST section. */
export function RestSection({ preferences, update }: SectionProps) {
  const rest: PreferencesWire['rest'] = preferences.rest;
  return (
    <>
      <SettingsGroup title="Redirects">
        <BooleanSetting
          label="Follow redirects"
          setting="rest.followRedirects"
          testId="rest-pref-follow-redirects"
          value={rest.followRedirects}
          onChange={(followRedirects) => update({ rest: { followRedirects } })}
          hint="What a request inherits when its own Settings tab says nothing."
        />
        <NumberSetting
          label="Maximum redirects"
          setting="rest.maxRedirects"
          testId="rest-pref-max-redirects"
          value={rest.maxRedirects}
          {...PREFERENCE_LIMITS['rest.maxRedirects']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.rest.maxRedirects)}
          onCommit={(maxRedirects) => {
            update({ rest: { maxRedirects: maxRedirects ?? DEFAULT_PREFERENCES_WIRE.rest.maxRedirects } });
          }}
          hint="A chain longer than this fails rather than looping."
        />
      </SettingsGroup>

      <SettingsGroup title="Requests">
        <TextSetting
          label="Default Accept header"
          setting="rest.defaultAccept"
          testId="rest-pref-default-accept"
          value={rest.defaultAccept}
          monospace
          trim
          validate={headerValueProblem}
          onCommit={(defaultAccept) => update({ rest: { defaultAccept } })}
          hint="Sent unless the request sets its own Accept header. Empty sends none."
        />
      </SettingsGroup>

      <SettingsGroup title="Responses">
        <NumberSetting
          label="Pretty-print up to"
          setting="rest.prettyPrintMaxBytes"
          testId="rest-pref-pretty-max"
          value={toMib(rest.prettyPrintMaxBytes)}
          {...PRETTY_MIB}
          unit="MiB"
          placeholder={String(toMib(DEFAULT_PREFERENCES_WIRE.rest.prettyPrintMaxBytes))}
          onCommit={(mib) => {
            update({
              rest: {
                prettyPrintMaxBytes:
                  mib === undefined ? DEFAULT_PREFERENCES_WIRE.rest.prettyPrintMaxBytes : Math.round(mib * MIB),
              },
            });
          }}
          hint="Above this, the response body opens on Raw — reformatting a larger one reads as a hang."
        />
      </SettingsGroup>

      <SettingsGroup
        title="OAuth2"
        hint="The loopback listener only ever binds 127.0.0.1. Pin a port when a provider insists on an exact redirect URI; otherwise a free one is taken per sign-in."
      >
        <NumberSetting
          label="Callback port"
          setting="rest.oauth2CallbackPort"
          testId="rest-pref-oauth2-port"
          value={rest.oauth2CallbackPort}
          {...PREFERENCE_LIMITS['rest.oauth2CallbackPort']}
          placeholder="Any free port"
          onCommit={(port) => {
            // `null` clears the pinned port in main; `undefined` would leave it as it was.
            update({ rest: { oauth2CallbackPort: port ?? null } });
          }}
          hint="Empty takes a free port. The redirect URI is then http://127.0.0.1:<port>/callback."
        />
      </SettingsGroup>
    </>
  );
}
