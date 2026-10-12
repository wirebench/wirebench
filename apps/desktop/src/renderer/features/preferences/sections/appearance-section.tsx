import {
  BooleanSetting,
  EnumSetting,
  NumberSetting,
  SettingsGroup,
  TextSetting,
} from '../../../components/settings-grid.js';
import type { SectionProps } from './section-props.js';
import { PREFERENCE_LIMITS } from '../../../state/preference-limits.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../../state/preferences-defaults.js';

/**
 * Settings → Appearance: how things look. The theme, Monaco's font, indent and wrapping, and the
 * layout a newly opened request gets. The fields still live in the `ui` and `editor` sections of
 * the preferences document; only where they are shown changed.
 */
export function AppearanceSection({ preferences, update }: SectionProps) {
  const editor = preferences.editor;
  const ui = preferences.ui;
  return (
    <>
      <SettingsGroup title="Theme">
        <EnumSetting
          label="Theme"
          value={ui.theme}
          testId="preferences-theme"
          setting="ui.theme"
          hint="Follow the system, or pick one."
          options={[
            { value: 'system', label: 'System' },
            { value: 'light', label: 'Light' },
            { value: 'dark', label: 'Dark' },
          ]}
          onChange={(theme) => update({ ui: { theme } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Editor">
        <TextSetting
          label="Font family"
          value={editor.fontFamily ?? ''}
          placeholder="JetBrains Mono, SF Mono, Menlo, monospace"
          monospace
          trim
          setting="editor.fontFamily"
          hint="Used in body editors and responses."
          onCommit={(fontFamily) => update({ editor: { fontFamily } })}
        />
        <NumberSetting
          label="Font size"
          value={editor.fontSize}
          {...PREFERENCE_LIMITS['editor.fontSize']}
          unit="px"
          placeholder={String(DEFAULT_PREFERENCES_WIRE.editor.fontSize)}
          setting="editor.fontSize"
          onCommit={(fontSize) =>
            update({ editor: { fontSize: fontSize ?? DEFAULT_PREFERENCES_WIRE.editor.fontSize } })
          }
        />
        <NumberSetting
          label="Tab size"
          value={editor.tabSize}
          {...PREFERENCE_LIMITS['editor.tabSize']}
          placeholder={String(DEFAULT_PREFERENCES_WIRE.editor.tabSize)}
          testId="preferences-tab-size"
          setting="editor.tabSize"
          onCommit={(tabSize) => update({ editor: { tabSize: tabSize ?? DEFAULT_PREFERENCES_WIRE.editor.tabSize } })}
          hint="Also the indent used when formatting or recreating an envelope."
        />
        <BooleanSetting
          label="Line numbers"
          value={editor.lineNumbers}
          setting="editor.lineNumbers"
          onChange={(lineNumbers) => update({ editor: { lineNumbers } })}
        />
        <BooleanSetting
          label="Word wrap"
          value={editor.wordWrap}
          setting="editor.wordWrap"
          hint="Wrap long lines instead of scrolling sideways."
          onChange={(wordWrap) => update({ editor: { wordWrap } })}
        />
      </SettingsGroup>

      <SettingsGroup title="Default request layout">
        <EnumSetting
          label="Orientation"
          value={ui.defaultLayout.orientation}
          setting="ui.defaultLayout.orientation"
          hint="Where the response sits relative to the request."
          options={[
            { value: 'side-by-side', label: 'Side by side' },
            { value: 'stacked', label: 'Stacked' },
          ]}
          onChange={(orientation) => update({ ui: { defaultLayout: { ...ui.defaultLayout, orientation } } })}
        />
        <EnumSetting
          label="Mode"
          value={ui.defaultLayout.mode}
          setting="ui.defaultLayout.mode"
          options={[
            { value: 'split', label: 'Split' },
            { value: 'tabs', label: 'Tabs' },
          ]}
          onChange={(mode) => update({ ui: { defaultLayout: { ...ui.defaultLayout, mode } } })}
        />
      </SettingsGroup>
    </>
  );
}
