/**
 * REST defaults: what a request inherits when it sets nothing of its own.
 *
 * Every value here is a *floor*, not a lock — a request's own Settings tab overrides any of them —
 * which is why each hint says what it applies to rather than what it forbids.
 */
import { NumberSetting, SettingsGroup, TextSetting, BooleanSetting } from '../../../components/settings-grid.js';
import type { PreferencesWire } from '../../../../shared/wire-types.js';
import type { SectionProps } from './section-props.js';

/** Bytes as a whole number of mebibytes, for the pretty-print threshold's field. */
function toMib(bytes: number): number {
  return Math.round((bytes / (1024 * 1024)) * 10) / 10;
}

/** The REST section. */
export function RestSection({ preferences, update }: SectionProps) {
  const rest: PreferencesWire['rest'] = preferences.rest;
  return (
    <>
      <SettingsGroup title="Redirects">
        <BooleanSetting
          label="Follow redirects"
          testId="rest-pref-follow-redirects"
          value={rest.followRedirects}
          onChange={(followRedirects) => update({ rest: { followRedirects } })}
          hint="What a request inherits when its own Settings tab says nothing."
        />
        <NumberSetting
          label="Maximum redirects"
          testId="rest-pref-max-redirects"
          value={rest.maxRedirects}
          min={0}
          onCommit={(maxRedirects) => {
            if (maxRedirects !== undefined) {
              update({ rest: { maxRedirects } });
            }
          }}
          hint="A chain longer than this fails rather than looping."
        />
      </SettingsGroup>

      <SettingsGroup title="Requests">
        <TextSetting
          label="Default Accept header"
          testId="rest-pref-default-accept"
          value={rest.defaultAccept}
          monospace
          onCommit={(defaultAccept) => update({ rest: { defaultAccept } })}
          hint="Sent unless the request sets its own Accept header. Empty sends none."
        />
      </SettingsGroup>

      <SettingsGroup title="Responses">
        <NumberSetting
          label="Pretty-print up to (MiB)"
          testId="rest-pref-pretty-max"
          value={toMib(rest.prettyPrintMaxBytes)}
          min={0}
          onCommit={(mib) => {
            if (mib !== undefined) {
              update({ rest: { prettyPrintMaxBytes: Math.round(mib * 1024 * 1024) } });
            }
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
          testId="rest-pref-oauth2-port"
          value={rest.oauth2CallbackPort}
          min={0}
          onCommit={(port) => {
            update({ rest: { oauth2CallbackPort: port === undefined || port === 0 ? undefined : port } });
          }}
          hint="Empty takes a free port. The redirect URI is then http://127.0.0.1:<port>/callback."
        />
      </SettingsGroup>
    </>
  );
}
