import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import { useInstalledMonospaceFonts } from '../../../lib/installed-fonts.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';
import { APP_SCHEME_ID, schemeLabel, TERMINAL_SCHEMES } from '../../ssh/terminal-schemes.js';
import type { SectionProps } from './section-props.js';

const FONT_HINT = 'Tried first; the app’s monospace font fills in for any character it lacks.';

/**
 * The terminal's font family: a list of the machine's monospaced families, or a text field where the
 * platform cannot list them. A family set before but no longer installed stays in the list, marked.
 */
function FontFamilySetting({
  value,
  onCommit,
}: {
  readonly value: string;
  readonly onCommit: (family: string) => void;
}) {
  const fonts = useInstalledMonospaceFonts();
  if (fonts === null) {
    return (
      <TextSetting
        label="Font family"
        value={value}
        placeholder="The app’s monospace font"
        monospace
        trim
        setting="terminal.fontFamily"
        hint={FONT_HINT}
        onCommit={onCommit}
      />
    );
  }
  const listed = fonts ?? [];
  const options = [
    { value: '', label: 'App default' },
    ...(value === '' || listed.includes(value)
      ? []
      : [{ value, label: fonts === undefined ? value : `${value} (not installed)` }]),
    ...listed.map((family) => ({ value: family, label: family })),
  ];
  return (
    <EnumSetting
      label="Font family"
      value={value}
      options={options}
      display="select"
      setting="terminal.fontFamily"
      hint={FONT_HINT}
      onChange={onCommit}
    />
  );
}

/**
 * Preferences → Terminal: how a terminal looks (a host or group in hosts.yaml may override the scheme and
 * size), what it does with a paste and with a selection, whether it suggests snippets while the user types,
 * and whether a session the network dropped reconnects on its own.
 */
export function TerminalSection({ preferences, update }: SectionProps) {
  const terminal = preferences.terminal;
  return (
    <>
      <SettingsGroup title="Appearance">
        <FontFamilySetting
          value={terminal.fontFamily ?? ''}
          onCommit={(fontFamily) => {
            update({ terminal: { fontFamily } });
          }}
        />
        <NumberSetting
          label="Font size"
          value={terminal.fontSize}
          {...PREFERENCE_LIMITS['terminal.fontSize']}
          unit="px"
          placeholder={String(DEFAULT_PREFERENCES_WIRE.terminal.fontSize)}
          setting="terminal.fontSize"
          onCommit={(fontSize) => {
            update({ terminal: { fontSize: fontSize ?? DEFAULT_PREFERENCES_WIRE.terminal.fontSize } });
          }}
          hint="⌘+ and ⌘− (Ctrl on Windows and Linux) resize the focused terminal until it closes; ⌘0 puts it back."
        />
        <NumberSetting
          label="Line height"
          value={terminal.lineHeight}
          {...PREFERENCE_LIMITS['terminal.lineHeight']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.terminal.lineHeight)}
          setting="terminal.lineHeight"
          onCommit={(lineHeight) => {
            update({ terminal: { lineHeight: lineHeight ?? DEFAULT_PREFERENCES_WIRE.terminal.lineHeight } });
          }}
          hint="A multiple of the font size, from 1 to 2."
        />
        <EnumSetting
          label="Colour scheme"
          value={terminal.colorScheme}
          options={[APP_SCHEME_ID, ...TERMINAL_SCHEMES.map((scheme) => scheme.id)].map((id) => ({
            value: id,
            label: schemeLabel(id),
          }))}
          display="select"
          setting="terminal.colorScheme"
          onChange={(colorScheme) => {
            update({ terminal: { colorScheme } });
          }}
          hint="A host or group can set its own in its form, so production and staging look different."
        />
      </SettingsGroup>
      <SettingsGroup title="Clipboard">
        <BooleanSetting
          label="Confirm multi-line paste"
          setting="terminal.confirmMultilinePaste"
          value={terminal.confirmMultilinePaste}
          onChange={(confirmMultilinePaste) => {
            update({ terminal: { confirmMultilinePaste } });
          }}
          hint="Ask before text with more than one line reaches the shell: a pasted script runs line by line."
        />
        <BooleanSetting
          label="Copy on select"
          setting="terminal.copyOnSelect"
          value={terminal.copyOnSelect}
          onChange={(copyOnSelect) => {
            update({ terminal: { copyOnSelect } });
          }}
          hint="Put the selection on the clipboard as soon as it is made."
        />
      </SettingsGroup>
      <SettingsGroup title="Snippets">
        <BooleanSetting
          label="Suggest snippets"
          setting="terminal.snippetSuggestions"
          value={terminal.snippetSuggestions}
          onChange={(snippetSuggestions) => {
            update({ terminal: { snippetSuggestions } });
          }}
          hint="While you type the start of a snippet's first line, show the rest dimmed after the cursor; Tab completes it without pressing Enter."
        />
      </SettingsGroup>
      <SettingsGroup title="Connection">
        <BooleanSetting
          label="Reconnect dropped sessions"
          setting="terminal.autoReconnect"
          value={terminal.autoReconnect}
          onChange={(autoReconnect) => {
            update({ terminal: { autoReconnect } });
          }}
          hint="When the network drops a session, try again with backoff; at once on wake from sleep or when the network returns. Never after the shell exits, a sign-in failure or a changed host key."
        />
        <NumberSetting
          label="Reconnect attempts"
          setting="terminal.reconnectAttempts"
          value={terminal.reconnectAttempts}
          {...PREFERENCE_LIMITS['terminal.reconnectAttempts']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.terminal.reconnectAttempts)}
          testId="terminal-reconnect-attempts"
          readOnly={!terminal.autoReconnect}
          onCommit={(reconnectAttempts) => {
            update({
              terminal: {
                reconnectAttempts: reconnectAttempts ?? DEFAULT_PREFERENCES_WIRE.terminal.reconnectAttempts,
              },
            });
          }}
          hint="How many tries a dropped session gets before the tab stops and offers Reconnect."
        />
      </SettingsGroup>
    </>
  );
}
