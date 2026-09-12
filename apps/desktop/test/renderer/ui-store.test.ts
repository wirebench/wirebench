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

  it('ignores a payload from a version it does not know how to read', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 999, state: { theme: 'light' } }));

    expect(readUi(storage)).toEqual(DEFAULT_UI_STATE);
  });

  it('migrates a version-3 blob, dropping `details` without losing the rest', () => {
    const storage = fakeStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        state: {
          sidebar: { visible: false, view: 'history', size: 31 },
          console: { visible: false, activeTab: 'problems', size: 42 },
          details: { visible: true, size: 20, tab: 'code', codeShell: 'powershell' },
          theme: 'light',
          editorLineNumbers: false,
          editorLayout: { orientation: 'stacked', mode: 'tabs' },
          workspaces: { w1: { tabs: [{ kind: 'request', id: 'req-1' }], activeId: 'req-1' } },
        },
      }),
    );

    const result = readUi(storage);

    expect(() => readUi(storage)).not.toThrow();
    expect(result).toEqual({
      // `lastSize` was never written by a v3 blob; it seeds from the stored `size` (31 / 42),
      // not the global default (20 / 25) — see the dedicated migration test below.
      sidebar: { visible: false, view: 'history', size: 31, lastSize: 31 },
      console: { visible: false, activeTab: 'problems', size: 42, lastSize: 42 },
      // Carried forward from the removed `details` slice; see ui-state-v4.test.tsx.
      slideOver: { ...DEFAULT_UI_STATE.slideOver, codeShell: 'powershell' },
      theme: 'light',
      editorLineNumbers: false,
      editorLayout: { orientation: 'stacked', mode: 'tabs' },
      workspaces: { w1: { tabs: [{ kind: 'request', id: 'req-1' }], activeId: 'req-1' } },
    });
    expect(result).not.toHaveProperty('details');
  });

  it('seeds `lastSize` from the stored `size` when a v3 blob has none, not the global default', () => {
    const storage = fakeStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: 3,
        state: {
          sidebar: { visible: true, view: 'explorer', size: 33 },
          console: { visible: true, activeTab: 'http-log', size: 44 },
          workspaces: {},
        },
      }),
    );

    const result = readUi(storage);

    expect(result.sidebar.lastSize).toBe(33);
    expect(result.console.lastSize).toBe(44);
    // Sanity: this only matters because the sizes here differ from the global defaults.
    expect(result.sidebar.lastSize).not.toBe(DEFAULT_UI_STATE.sidebar.lastSize);
    expect(result.console.lastSize).not.toBe(DEFAULT_UI_STATE.console.lastSize);
  });

  it('a v4 blob missing `lastSize` also seeds it from the stored `size`', () => {
    const storage = fakeStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: UI_STORAGE_VERSION,
        state: { sidebar: { visible: true, view: 'explorer', size: 37 } },
      }),
    );

    expect(readUi(storage).sidebar).toEqual({ visible: true, view: 'explorer', size: 37, lastSize: 37 });
  });

  it('a stored `lastSize` is honoured over the stored `size`', () => {
    const storage = fakeStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({
        version: UI_STORAGE_VERSION,
        state: { sidebar: { visible: true, view: 'explorer', size: 12, lastSize: 28 } },
      }),
    );

    expect(readUi(storage).sidebar).toMatchObject({ size: 12, lastSize: 28 });
  });

  it('falls back to defaults for a blob that parses to something other than an object', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, 'null');

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

  it('rejects a stored slide-over shape it does not recognise, field by field', () => {
    const storage = fakeStorage();
    storage.setItem(
      UI_STORAGE_KEY,
      JSON.stringify({ version: UI_STORAGE_VERSION, state: { slideOver: { open: 'yes', width: 'wide' } } }),
    );

    expect(readUi(storage).slideOver).toEqual(DEFAULT_UI_STATE.slideOver);
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

  it('toggles the console and the Code slide-over independently', () => {
    useUiStore.getState().toggleConsole();

    expect(useUiStore.getState().console.visible).toBe(false);
    expect(useUiStore.getState().slideOver.open).toBe(DEFAULT_UI_STATE.slideOver.open);

    useUiStore.getState().toggleCode();

    expect(useUiStore.getState().slideOver.open).toBe(true);
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
    useUiStore.getState().setSlideOverWidth(500);

    expect(useUiStore.getState().sidebar.size).toBe(31);
    expect(useUiStore.getState().console.size).toBe(42);
    expect(useUiStore.getState().slideOver.width).toBe(500);
  });

  it('selects a console tab and reveals the console', () => {
    useUiStore.getState().toggleConsole();
    useUiStore.getState().showConsoleTab('problems');

    expect(useUiStore.getState().console).toMatchObject({ visible: true, activeTab: 'problems' });
  });

  it('openCode reveals the slide-over unconditionally', () => {
    expect(useUiStore.getState().slideOver.open).toBe(false);

    useUiStore.getState().openCode();
    expect(useUiStore.getState().slideOver.open).toBe(true);

    // Calling it again while already open is a no-op, not a toggle.
    useUiStore.getState().openCode();
    expect(useUiStore.getState().slideOver.open).toBe(true);
  });

  it('closeCode hides the slide-over unconditionally', () => {
    useUiStore.getState().openCode();

    useUiStore.getState().closeCode();
    expect(useUiStore.getState().slideOver.open).toBe(false);

    useUiStore.getState().closeCode();
    expect(useUiStore.getState().slideOver.open).toBe(false);
  });

  it('toggleCode flips the slide-over open state', () => {
    expect(useUiStore.getState().slideOver.open).toBe(false);

    useUiStore.getState().toggleCode();
    expect(useUiStore.getState().slideOver.open).toBe(true);

    useUiStore.getState().toggleCode();
    expect(useUiStore.getState().slideOver.open).toBe(false);
  });

  it('exposes a snapshot free of action functions', () => {
    const snapshot = useUiStore.getState().snapshot();

    expect(Object.keys(snapshot).sort()).toEqual([
      'console',
      'editorLayout',
      'editorLineNumbers',
      'sidebar',
      'slideOver',
      'theme',
      'workspaces',
    ]);
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
