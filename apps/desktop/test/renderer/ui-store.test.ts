import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  DEFAULT_UI_STATE,
  UI_STORAGE_KEY,
  UI_STORAGE_VERSION,
  readUi,
  writeUi,
} from '../../src/renderer/state/ui-state.js';
import { useUiStore } from '../../src/renderer/state/ui.js';

function fakeStorage(): Storage {
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

describe('ui persistence', () => {
  it('round-trips the state through storage', () => {
    const storage = fakeStorage();
    const state = { ...DEFAULT_UI_STATE, theme: 'light' as const };

    writeUi(state, storage);

    expect(storage.getItem(UI_STORAGE_KEY)).toContain(`"version":${String(UI_STORAGE_VERSION)}`);
    expect(readUi(storage)).toEqual(state);
  });

  it('falls back to defaults when nothing is stored', () => {
    expect(readUi(fakeStorage())).toEqual(DEFAULT_UI_STATE);
  });

  it('tolerates corrupted JSON', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, '{ not json');

    expect(readUi(storage)).toEqual(DEFAULT_UI_STATE);
  });

  it('ignores a payload from a different version', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 999, state: { theme: 'light' } }));

    expect(readUi(storage)).toEqual(DEFAULT_UI_STATE);
  });

  it('merges partial stored state over the defaults', () => {
    const storage = fakeStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ version: UI_STORAGE_VERSION, state: { sidebar: { visible: false } } }),
    );

    expect(readUi(storage).sidebar).toEqual({ ...DEFAULT_UI_STATE.sidebar, visible: false });
    expect(readUi(storage).console).toEqual(DEFAULT_UI_STATE.console);
  });

  it('survives a storage that throws (private mode, disabled site data)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
      setItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(readUi(throwing)).toEqual(DEFAULT_UI_STATE);
    expect(() => {
      writeUi(DEFAULT_UI_STATE, throwing);
    }).not.toThrow();
  });
});

describe('useUiStore', () => {
  beforeEach(() => {
    useUiStore.setState(structuredClone(DEFAULT_UI_STATE));
  });

  it('toggles the sidebar', () => {
    useUiStore.getState().toggleSidebar();

    expect(useUiStore.getState().sidebar.visible).toBe(false);
  });

  it('toggles the console and the details panel independently', () => {
    useUiStore.getState().toggleConsole();

    expect(useUiStore.getState().console.visible).toBe(false);
    expect(useUiStore.getState().details.visible).toBe(DEFAULT_UI_STATE.details.visible);

    useUiStore.getState().toggleDetails();

    expect(useUiStore.getState().details.visible).toBe(false);
  });

  it('shows a sidebar view, revealing the sidebar when hidden', () => {
    useUiStore.getState().toggleSidebar();
    useUiStore.getState().showSidebarView('history');

    expect(useUiStore.getState().sidebar).toMatchObject({ visible: true, view: 'history' });
  });

  it('collapses the sidebar when the already-active view is selected again', () => {
    useUiStore.getState().showSidebarView('explorer');

    expect(useUiStore.getState().sidebar.visible).toBe(false);
  });

  it('cycles the theme between dark and light', () => {
    useUiStore.getState().toggleTheme();

    expect(useUiStore.getState().theme).toBe('light');

    useUiStore.getState().toggleTheme();

    expect(useUiStore.getState().theme).toBe('dark');
  });

  it('remembers panel sizes', () => {
    useUiStore.getState().setSidebarSize(31);
    useUiStore.getState().setConsoleSize(42);
    useUiStore.getState().setDetailsSize(17);

    expect(useUiStore.getState().sidebar.size).toBe(31);
    expect(useUiStore.getState().console.size).toBe(42);
    expect(useUiStore.getState().details.size).toBe(17);
  });

  it('selects a console tab and reveals the console', () => {
    useUiStore.getState().toggleConsole();
    useUiStore.getState().showConsoleTab('problems');

    expect(useUiStore.getState().console).toMatchObject({ visible: true, activeTab: 'problems' });
  });

  it('exposes a snapshot free of action functions', () => {
    const snapshot = useUiStore.getState().snapshot();

    expect(Object.keys(snapshot).sort()).toEqual(['console', 'details', 'editorLineNumbers', 'sidebar', 'theme']);
  });

  it('persists on every change', () => {
    const storage = fakeStorage();
    const spy = vi.spyOn(storage, 'setItem');
    useUiStore.getState().persistTo(storage);

    useUiStore.getState().toggleSidebar();

    expect(spy).toHaveBeenCalled();
    expect(readUi(storage).sidebar.visible).toBe(false);
    useUiStore.getState().persistTo(undefined);
  });
});
