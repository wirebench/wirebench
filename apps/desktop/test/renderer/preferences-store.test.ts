import { beforeEach, describe, expect, it, vi } from 'vitest';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import { installWirebenchApi } from '../mocks/wirebench-api.js';

describe('preferences store', () => {
  beforeEach(() => {
    installWirebenchApi();
    usePreferencesStore.setState({ preferences: DEFAULT_PREFERENCES_WIRE, loaded: false });
  });

  it('loads the document from main', async () => {
    await usePreferencesStore.getState().load();
    expect(usePreferencesStore.getState().loaded).toBe(true);
    expect(usePreferencesStore.getState().preferences.http.userAgent).toBe('Wirebench/0.1');
  });

  /**
   * The shell renders from the `ui` store many times per frame and cannot await IPC, so every
   * incoming document is pushed into it. Without this, changing the theme in Preferences would
   * only take effect on the next launch.
   */
  it('pushes the theme, gutter and default layout into the ui store', async () => {
    useUiStore.getState().setTheme('dark');
    usePreferencesStore.getState().applyPreferences({
      ...DEFAULT_PREFERENCES_WIRE,
      editor: { ...DEFAULT_PREFERENCES_WIRE.editor, lineNumbers: false },
      ui: {
        ...DEFAULT_PREFERENCES_WIRE.ui,
        theme: 'light',
        defaultLayout: { orientation: 'stacked', mode: 'tabs' },
      },
    });

    expect(useUiStore.getState().theme).toBe('light');
    expect(useUiStore.getState().editorLineNumbers).toBe(false);
    expect(useUiStore.getState().editorLayout).toEqual({ orientation: 'stacked', mode: 'tabs' });
    await Promise.resolve();
  });

  it("applies an update optimistically, then takes main's reply", async () => {
    const update = vi.fn().mockResolvedValue({
      ok: true,
      value: {
        preferences: { ...DEFAULT_PREFERENCES_WIRE, editor: { ...DEFAULT_PREFERENCES_WIRE.editor, tabSize: 7 } },
      },
    });
    installWirebenchApi({ preferences: { update } });

    const pending = usePreferencesStore.getState().update({ editor: { tabSize: 2 } });
    // Optimistic: the mirror already shows 2 before the round trip resolves.
    expect(usePreferencesStore.getState().preferences.editor.tabSize).toBe(2);
    await pending;
    // …and then whatever main actually persisted wins.
    expect(usePreferencesStore.getState().preferences.editor.tabSize).toBe(7);
  });

  it('keeps the previous document when an update fails', async () => {
    installWirebenchApi({
      preferences: { update: vi.fn().mockResolvedValue({ ok: false, error: { code: 'boom', message: 'no' } }) },
    });
    await usePreferencesStore.getState().update({ editor: { tabSize: 2 } });
    // The optimistic value stands: nothing came back to correct it, and the next `load`
    // (or `preferences.changed`) will.
    expect(usePreferencesStore.getState().preferences.editor.tabSize).toBe(2);
  });

  it('resets a section through main', async () => {
    const reset = vi.fn().mockResolvedValue({ ok: true, value: { preferences: DEFAULT_PREFERENCES_WIRE } });
    installWirebenchApi({ preferences: { reset } });
    await usePreferencesStore.getState().reset('editor');
    expect(reset).toHaveBeenCalledWith({ section: 'editor' });

    await usePreferencesStore.getState().reset();
    expect(reset).toHaveBeenLastCalledWith({});
  });
});
