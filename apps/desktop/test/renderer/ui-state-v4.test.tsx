import { describe, expect, it } from 'vitest';
import {
  DEFAULT_UI_STATE,
  UI_STORAGE_KEY,
  UI_STORAGE_VERSION,
  readUi,
  writeUi,
} from '../../src/renderer/state/ui-state.js';

/**
 * `UI_STORAGE_VERSION` went 3 → 4 when the right panel (and its `details` slice) was replaced
 * by the right rail and the Code slide-over (Task 8). This file is the migration's dedicated
 * coverage: a real user has a version-3 blob in `localStorage` right now, and it must keep
 * working — see the risk note in the task brief.
 */

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

/** A representative version-3 payload: every section a real user's blob would carry. */
function v3Payload(): unknown {
  return {
    version: 3,
    state: {
      sidebar: { visible: false, view: 'wss', size: 27 },
      console: { visible: true, activeTab: 'errors', size: 33 },
      // The section this migration removes. It must not throw the reader, and it must not
      // survive into the v4 result.
      details: { visible: true, size: 20, tab: 'code', codeShell: 'powershell' },
      theme: 'light',
      editorLineNumbers: false,
      editorLayout: { orientation: 'stacked', mode: 'tabs' },
      workspaces: {
        'w-1': {
          tabs: [
            { kind: 'request', id: 'req-1' },
            { kind: 'project', id: 'proj-1' },
          ],
          activeId: 'req-1',
        },
      },
    },
  };
}

describe('ui-state v4 migration', () => {
  it('migrates a version-3 blob without throwing, dropping `details`', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, JSON.stringify(v3Payload()));

    let result: ReturnType<typeof readUi> | undefined;
    expect(() => {
      result = readUi(storage);
    }).not.toThrow();

    expect(result).not.toHaveProperty('details');
  });

  it('keeps the user’s other preferences intact across the v3 → v4 migration', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, JSON.stringify(v3Payload()));

    const result = readUi(storage);

    // Theme, editor settings and panel sizes.
    expect(result.theme).toBe('light');
    expect(result.editorLineNumbers).toBe(false);
    expect(result.editorLayout).toEqual({ orientation: 'stacked', mode: 'tabs' });
    expect(result.sidebar).toMatchObject({ visible: false, view: 'wss', size: 27 });
    expect(result.console).toMatchObject({ visible: true, activeTab: 'errors', size: 33 });
    // Workspaces (open tabs per workspace) survive untouched.
    expect(result.workspaces).toEqual({
      'w-1': {
        tabs: [
          { kind: 'request', id: 'req-1' },
          { kind: 'project', id: 'proj-1' },
        ],
        activeId: 'req-1',
      },
    });
    // The new slice a v3 blob never had gets the default rather than being left undefined.
    expect(result.slideOver).toEqual(DEFAULT_UI_STATE.slideOver);
  });

  it('rewrites a migrated v3 blob as v4 on the next write', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, JSON.stringify(v3Payload()));

    writeUi(readUi(storage), storage);

    const persisted = JSON.parse(storage.getItem(UI_STORAGE_KEY) ?? 'null') as { version: number };
    expect(persisted.version).toBe(UI_STORAGE_VERSION);
    expect(persisted.version).toBe(4);
  });

  it('round-trips a v4 blob exactly', () => {
    const storage = fakeStorage();
    const state = {
      ...DEFAULT_UI_STATE,
      slideOver: { open: true, width: 520 },
      sidebar: { ...DEFAULT_UI_STATE.sidebar, size: 24, lastSize: 24 },
    };

    writeUi(state, storage);

    expect(readUi(storage)).toEqual(state);
  });

  it('falls back to defaults rather than throwing for a missing blob', () => {
    const storage = fakeStorage();

    expect(() => readUi(storage)).not.toThrow();
    expect(readUi(storage)).toEqual(DEFAULT_UI_STATE);
  });

  it('falls back to defaults rather than throwing for a corrupt (unparseable) blob', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, '{ this is not valid json');

    expect(() => readUi(storage)).not.toThrow();
    expect(readUi(storage)).toEqual(DEFAULT_UI_STATE);
  });

  it('falls back to defaults rather than throwing for a payload from an unknown version', () => {
    const storage = fakeStorage();
    storage.setItem(UI_STORAGE_KEY, JSON.stringify({ version: 1, state: { theme: 'light' } }));

    expect(() => readUi(storage)).not.toThrow();
    expect(readUi(storage)).toEqual(DEFAULT_UI_STATE);
  });

  it('falls back to defaults when storage itself throws (private mode, disabled site data)', () => {
    const throwing = {
      getItem: () => {
        throw new Error('denied');
      },
    } as unknown as Storage;

    expect(() => readUi(throwing)).not.toThrow();
    expect(readUi(throwing)).toEqual(DEFAULT_UI_STATE);
  });
});
