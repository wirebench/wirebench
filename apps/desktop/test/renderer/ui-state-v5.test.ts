import { afterEach, describe, expect, it } from 'vitest';
import { PALETTES } from '@shared/palettes.js';
import { DEFAULT_PREFERENCES_WIRE } from '../../src/renderer/state/preferences-defaults.js';
import { usePreferencesStore } from '../../src/renderer/state/preferences.js';
import { useUiStore } from '../../src/renderer/state/ui.js';
import {
  DEFAULT_UI_STATE,
  UI_STORAGE_KEY,
  UI_STORAGE_VERSION,
  readUi,
  writeUi,
} from '../../src/renderer/state/ui-state.js';

/**
 * `UI_STORAGE_VERSION` went 4 → 5 when the mirror gained the colour theme (`palette`), which the
 * pre-render `applyInitialTheme` reads so the first frame already wears it. A version-4 blob is
 * a real user's layout today and must keep every field, reading as the default palette.
 */

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return {
    get length() {
      return map.size;
    },
    clear: () => map.clear(),
    getItem: (key: string) => map.get(key) ?? null,
    key: (index: number) => [...map.keys()][index] ?? null,
    removeItem: (key: string) => void map.delete(key),
    setItem: (key: string, value: string) => void map.set(key, value),
  };
}

function stored(version: number, state: Record<string, unknown>): Storage {
  const storage = memoryStorage();
  storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version, state }));
  return storage;
}

describe('ui-state v5: the palette', () => {
  it('is version 5', () => {
    expect(UI_STORAGE_VERSION).toBe(5);
  });

  it('starts as the default palette', () => {
    expect(DEFAULT_UI_STATE.palette).toBe('default');
  });

  it('reads a version-4 blob as the default palette, keeping its other fields', () => {
    const ui = readUi(stored(4, { theme: 'light', editorLineNumbers: false }));
    expect(ui.palette).toBe('default');
    expect(ui.theme).toBe('light');
    expect(ui.editorLineNumbers).toBe(false);
  });

  it.each(PALETTES)('reads a version-5 blob with %s', (palette) => {
    expect(readUi(stored(5, { palette })).palette).toBe(palette);
  });

  it('reads a bad value as the default palette', () => {
    expect(readUi(stored(5, { palette: 'neon' })).palette).toBe('default');
    expect(readUi(stored(5, { palette: 7 })).palette).toBe('default');
  });

  it('writes the palette and reads it back', () => {
    const storage = memoryStorage();
    writeUi({ ...DEFAULT_UI_STATE, palette: 'rind' }, storage);
    expect(readUi(storage).palette).toBe('rind');
  });
});

describe('the ui store mirrors preferences.ui.palette', () => {
  afterEach(() => {
    useUiStore.getState().setPalette('default');
  });

  it('carries a preferences update to the ui store', () => {
    usePreferencesStore.getState().applyPreferences({
      ...DEFAULT_PREFERENCES_WIRE,
      ui: { ...DEFAULT_PREFERENCES_WIRE.ui, palette: 'sandstone' },
    });
    expect(useUiStore.getState().palette).toBe('sandstone');
    expect(useUiStore.getState().snapshot().palette).toBe('sandstone');

    usePreferencesStore.getState().applyPreferences({
      ...DEFAULT_PREFERENCES_WIRE,
      ui: { ...DEFAULT_PREFERENCES_WIRE.ui, palette: 'seed' },
    });
    expect(useUiStore.getState().palette).toBe('seed');
  });
});
