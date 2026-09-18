import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';

/** Editor preferences: Monaco's font/indent/wrapping plus what happens around a send. */
export function EditorSection({ preferences, update }: SectionProps) {
  const editor = preferences.editor;
  return (
    <>
      <SettingsGroup title="Appearance">
        <TextSetting
          label="Font family"
          value={editor.fontFamily ?? ''}
          placeholder="JetBrains Mono, SF Mono, Menlo, monospace"
          monospace
          onCommit={(fontFamily) => update({ editor: { fontFamily } })}
        />
        <NumberSetting
          label="Font size"
          value={editor.fontSize}
          min={6}
          onCommit={(fontSize) => update({ editor: { fontSize: fontSize ?? 12 } })}
        />
        <NumberSetting
          label="Tab size"
          value={editor.tabSize}
          min={1}
          testId="preferences-tab-size"
          onCommit={(tabSize) => update({ editor: { tabSize: tabSize ?? 3 } })}
          hint="Also the indent used when formatting or recreating an envelope."
        />
        <BooleanSetting
          label="Line numbers"
          value={editor.lineNumbers}
          onChange={(lineNumbers) => update({ editor: { lineNumbers } })}
        />
        <BooleanSetting
          label="Word wrap"
          value={editor.wordWrap}
          onChange={(wordWrap) => update({ editor: { wordWrap } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <BooleanSetting
          label="Validate before sending"
          value={editor.autoValidateOnSend}
          onChange={(autoValidateOnSend) => update({ editor: { autoValidateOnSend } })}
          hint="Takes effect with schema validation (Task 42)."
        />
        <BooleanSetting
          label="Format responses"
          value={editor.autoFormatResponses}
          onChange={(autoFormatResponses) => update({ editor: { autoFormatResponses } })}
        />
        <BooleanSetting
          label="Autosave projects"
          value={editor.autosave}
          onChange={(autosave) => update({ editor: { autosave } })}
          hint="Off: edits are yours until you save (⌘S / Ctrl+S). Closing a workspace and quitting always save."
        />
      </SettingsGroup>
    </>
  );
}

/** Shell preferences: theme, the default editor layout, confirmations and the history cap. */
export function UiSection({ preferences, update }: SectionProps) {
  const ui = preferences.ui;
  return (
    <>
      <SettingsGroup title="Appearance">
        <EnumSetting
          label="Theme"
          value={ui.theme}
          testId="preferences-theme"
          options={[
            { value: 'dark', label: 'Dark' },
            { value: 'light', label: 'Light' },
            { value: 'system', label: 'Follow the system' },
          ]}
          onChange={(theme) => update({ ui: { theme } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Default request layout">
        <EnumSetting
          label="Orientation"
          value={ui.defaultLayout.orientation}
          options={[
            { value: 'side-by-side', label: 'Side by side' },
            { value: 'stacked', label: 'Stacked' },
          ]}
          onChange={(orientation) => update({ ui: { defaultLayout: { ...ui.defaultLayout, orientation } } })}
        />
        <EnumSetting
          label="Mode"
          value={ui.defaultLayout.mode}
          options={[
            { value: 'split', label: 'Split' },
            { value: 'tabs', label: 'Tabs' },
          ]}
          onChange={(mode) => update({ ui: { defaultLayout: { ...ui.defaultLayout, mode } } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Behaviour">
        <BooleanSetting
          label="Confirm before deleting"
          value={ui.confirmOnDelete}
          onChange={(confirmOnDelete) => update({ ui: { confirmOnDelete } })}
        />
        <NumberSetting
          label="History entries kept"
          value={ui.historyCap}
          min={1}
          onCommit={(historyCap) => update({ ui: { historyCap: historyCap ?? 1000 } })}
        />
        <NumberSetting
          label="HTTP Log rows kept"
          value={ui.logSize}
          min={100}
          onCommit={(logSize) => update({ ui: { logSize: Math.min(5000, Math.max(100, logSize ?? 500)) } })}
        />
      </SettingsGroup>
    </>
  );
}
