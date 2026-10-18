import { BooleanSetting, NumberSetting, SettingsGroup } from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';

/**
 * Settings → Behaviour: what happens around a send and a save, confirmations, and how much
 * history is kept. The fields still live in the `editor` and `ui` sections of the preferences
 * document; only where they are shown changed.
 */
export function BehaviourSection({ preferences, update }: SectionProps) {
  const editor = preferences.editor;
  const ui = preferences.ui;
  return (
    <>
      <SettingsGroup title="Requests and projects">
        <BooleanSetting
          label="Validate before sending"
          value={editor.autoValidateOnSend}
          setting="editor.autoValidateOnSend"
          onChange={(autoValidateOnSend) => update({ editor: { autoValidateOnSend } })}
          hint="Check the request against its definition first."
        />
        <BooleanSetting
          label="Format responses"
          value={editor.autoFormatResponses}
          setting="editor.autoFormatResponses"
          onChange={(autoFormatResponses) => update({ editor: { autoFormatResponses } })}
          hint="Pretty-print JSON and XML when they arrive."
        />
        <BooleanSetting
          label="Autosave projects"
          value={editor.autosave}
          setting="editor.autosave"
          onChange={(autosave) => update({ editor: { autosave } })}
          hint="Off: edits are yours until you save (⌘S / Ctrl+S). Closing a workspace and quitting always save."
        />
        <BooleanSetting
          label="Confirm before deleting"
          value={ui.confirmOnDelete}
          setting="ui.confirmOnDelete"
          onChange={(confirmOnDelete) => update({ ui: { confirmOnDelete } })}
        />
        <BooleanSetting
          label="Preview tabs"
          value={ui.previewTabs}
          setting="ui.previewTabs"
          onChange={(previewTabs) => update({ ui: { previewTabs } })}
          hint="A single click in the Explorer opens a preview tab that the next click replaces. Double-click, edit or send to keep it."
        />
      </SettingsGroup>

      <SettingsGroup title="History">
        <NumberSetting
          label="History entries kept"
          value={ui.historyCap}
          {...PREFERENCE_LIMITS['ui.historyCap']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.ui.historyCap)}
          setting="ui.historyCap"
          onCommit={(historyCap) =>
            update({ ui: { historyCap: historyCap ?? DEFAULT_PREFERENCES_WIRE.ui.historyCap } })
          }
        />
        <NumberSetting
          label="HTTP Log rows kept"
          value={ui.logSize}
          {...PREFERENCE_LIMITS['ui.logSize']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.ui.logSize)}
          setting="ui.logSize"
          hint="Between 100 and 5000."
          onCommit={(logSize) => update({ ui: { logSize: logSize ?? DEFAULT_PREFERENCES_WIRE.ui.logSize } })}
        />
      </SettingsGroup>
    </>
  );
}
