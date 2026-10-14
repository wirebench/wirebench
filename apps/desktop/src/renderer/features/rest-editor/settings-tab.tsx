/**
 * The request's own transport settings.
 *
 * Every setting is optional, and an absent one means *inherit* — never *off*. So a row the request
 * has not set is left empty rather than pre-filled: a filled field would be indistinguishable from an
 * override, and saving it would freeze today's inherited value into the request. The inherited value
 * shows instead as the empty field's placeholder (or as the checkbox's state), with a short "from …"
 * link beside it to where that value is set (#560). An overridden on/off row offers "Inherit" to go
 * back.
 */
import { BooleanSetting, NumberSetting, SettingsGroup, TextSetting } from '../../components/settings-grid.js';
import type { RestRequestPatchWire, RestSettingsWire } from '../../../shared/kinds/rest/wire.js';

/** Where an inherited value is set, so the row can say so and open it. */
export type InheritedSource = 'project' | 'preferences-rest' | 'default';

/** How each source reads in the "from …" link. */
export const SOURCE_LABEL: Readonly<Record<InheritedSource, string>> = {
  project: 'Project settings',
  'preferences-rest': 'Preferences ▸ REST',
  default: 'the default',
};

/** The values a request falls back to, for the placeholders. */
export interface InheritedRestSettings {
  /** The project's Default timeout, which a send falls back to before any preference. */
  readonly timeoutMs: number;
  readonly followRedirects: boolean;
  readonly maxRedirects: number;
  readonly encodeUrl: boolean;
  readonly sendCookies: boolean;
}

/** Which source each inheriting setting reads; fixed by how a send resolves them (`toRestSendInput`). */
const SOURCES = {
  timeoutMs: 'project',
  followRedirects: 'preferences-rest',
  maxRedirects: 'preferences-rest',
  encodeUrl: 'default',
  sendCookies: 'default',
} as const satisfies Readonly<Record<keyof InheritedRestSettings, InheritedSource>>;

export interface SettingsTabProps {
  readonly settings: RestSettingsWire;
  readonly inherited: InheritedRestSettings;
  readonly onChange: (patch: RestRequestPatchWire) => void;
  /** Opens where an inherited value is set: the project's tab, or a Preferences page. */
  readonly onOpenSource?: (source: Exclude<InheritedSource, 'default'>) => void;
}

const LINK = 'shrink-0 text-xs whitespace-nowrap text-fg-subtle hover:text-accent hover:underline';

/** "from Preferences ▸ REST": where an inheriting row's value comes from, a link when it can be opened. */
function FromSource({
  source,
  testId,
  onOpen,
}: {
  readonly source: InheritedSource;
  readonly testId: string;
  readonly onOpen: SettingsTabProps['onOpenSource'];
}) {
  const text = `from ${SOURCE_LABEL[source]}`;
  if (source === 'default' || onOpen === undefined) {
    return (
      <span data-testid={`${testId}-source`} className="shrink-0 text-xs whitespace-nowrap text-fg-subtle">
        {text}
      </span>
    );
  }
  return (
    <button
      type="button"
      data-testid={`${testId}-source`}
      className={LINK}
      onClick={() => {
        onOpen(source);
      }}
    >
      {text}
    </button>
  );
}

/** The value an on/off row inherits, in words. */
function onOff(value: boolean): string {
  return value ? 'on' : 'off';
}

/** The Settings tab. */
export function SettingsTab({ settings, inherited, onChange, onOpenSource }: SettingsTabProps) {
  const patch = (next: RestSettingsWire): void => {
    onChange({ settings: next });
  };
  /** Drops a key so the setting goes back to inheriting, rather than storing a `false`/`0`. */
  const clear = (key: keyof RestSettingsWire): void => {
    const next = { ...settings };
    delete next[key];
    patch(next);
  };

  /** Beside a number row: where an empty field's value comes from. */
  const numberAside = (key: 'timeoutMs' | 'maxRedirects', testId: string) =>
    settings[key] === undefined ? (
      <FromSource source={SOURCES[key]} testId={testId} onOpen={onOpenSource} />
    ) : undefined;

  /** Beside an on/off row: where its value comes from, or a way back to inheriting it. */
  const booleanAside = (key: 'followRedirects' | 'encodeUrl' | 'sendCookies', testId: string) =>
    settings[key] === undefined ? (
      <FromSource source={SOURCES[key]} testId={testId} onOpen={onOpenSource} />
    ) : (
      <button
        type="button"
        data-testid={`${testId}-inherit`}
        className={LINK}
        title={`Inherit ${onOff(inherited[key])} ${`from ${SOURCE_LABEL[SOURCES[key]]}`}`}
        onClick={() => {
          clear(key);
        }}
      >
        Inherit
      </button>
    );

  return (
    <div data-testid="rest-settings" className="overflow-auto p-3">
      <SettingsGroup title="Transport" hint="An empty field inherits the value shown in it, from where it says.">
        <NumberSetting
          label="Timeout (ms)"
          testId="rest-setting-timeout"
          value={settings.timeoutMs}
          min={0}
          placeholder={String(inherited.timeoutMs)}
          hint={`Empty inherits ${String(inherited.timeoutMs)} ms from the project's Default timeout.`}
          aside={numberAside('timeoutMs', 'rest-setting-timeout')}
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
          placeholder={String(inherited.maxRedirects)}
          hint={`Empty inherits ${String(inherited.maxRedirects)} from Preferences ▸ REST.`}
          aside={numberAside('maxRedirects', 'rest-setting-max-redirects')}
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
          hint={`Unset inherits ${onOff(inherited.followRedirects)} from Preferences ▸ REST.`}
          aside={booleanAside('followRedirects', 'rest-setting-follow-redirects')}
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
          hint={`Unset is ${onOff(inherited.encodeUrl)}, the default.`}
          aside={booleanAside('encodeUrl', 'rest-setting-encode-url')}
          onChange={(value) => {
            patch({ ...settings, encodeUrl: value });
          }}
        />
        <BooleanSetting
          label="Send cookies"
          testId="rest-setting-send-cookies"
          value={settings.sendCookies ?? inherited.sendCookies}
          hint={`Unset is ${onOff(inherited.sendCookies)}, the default: jar cookies go only with a request that turns this on.`}
          aside={booleanAside('sendCookies', 'rest-setting-send-cookies')}
          onChange={(value) => {
            patch({ ...settings, sendCookies: value });
          }}
        />
        <NumberSetting
          label="Max response size (bytes)"
          testId="rest-setting-max-size"
          value={settings.maxSizeBytes}
          min={0}
          placeholder="No limit"
          hint="Empty reads the whole response."
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
          placeholder="Any"
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
