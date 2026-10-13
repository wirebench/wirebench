import { BooleanSetting, NumberSetting, SettingsGroup } from '../../../components/settings-grid.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';
import type { SectionProps } from './section-props.js';

/**
 * Preferences → Terminal: what the SSH terminal does with a paste and with a selection, whether it suggests
 * snippets while the user types, and whether a session the network dropped reconnects on its own.
 */
export function TerminalSection({ preferences, update }: SectionProps) {
  const terminal = preferences.terminal;
  return (
    <>
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
