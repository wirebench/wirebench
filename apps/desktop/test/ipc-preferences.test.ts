import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES } from '@wirebench/engine';
import { PREFERENCES_FILE, PreferencesService } from '../src/main/preferences.js';
import { registerPreferencesChannels } from '../src/main/ipc/preferences.js';
import type { PreferencesWire } from '../src/shared/wire-types.js';

// `registerPreferencesChannels` binds through `ipcMain.handle`; the stub captures the bound
// handlers so the registration itself is what these tests drive.
const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) {
    throw new Error(`no handler registered for ${channel}`);
  }
  return handler({ sender: {} }, payload);
}

let dir: string;

beforeEach(() => {
  handlers.clear();
  dir = mkdtempSync(join(tmpdir(), 'wirebench-prefs-ipc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

describe('preferences.* IPC', () => {
  it('answers preferences.get with the whole document', async () => {
    registerPreferencesChannels(new PreferencesService(dir));
    expect(await invoke('preferences.get', undefined)).toEqual({
      ok: true,
      value: { preferences: DEFAULT_PREFERENCES },
    });
  });

  /**
   * The startup race the globals channels already guard against: `preferences.get` must await
   * the initial load, or an early caller is stuck with the defaults forever.
   */
  it('waits for the initial load before answering', async () => {
    writeFileSync(join(dir, PREFERENCES_FILE), 'version: 1\nui:\n  theme: light\n', 'utf8');
    registerPreferencesChannels(new PreferencesService(dir));

    const result = (await invoke('preferences.get', undefined)) as { value: { preferences: PreferencesWire } };
    expect(result.value.preferences.ui.theme).toBe('light');
  });

  it('merges an update, persists it and notifies the broadcaster', async () => {
    const changed: PreferencesWire[] = [];
    registerPreferencesChannels(new PreferencesService(dir), (next) => changed.push(next));

    const result = (await invoke('preferences.update', { patch: { editor: { tabSize: 2 } } })) as {
      value: { preferences: PreferencesWire };
    };

    expect(result.value.preferences.editor.tabSize).toBe(2);
    expect(result.value.preferences.editor.fontSize).toBe(DEFAULT_PREFERENCES.editor.fontSize);
    expect(changed).toHaveLength(1);
    expect(changed[0]?.editor.tabSize).toBe(2);
    expect((await new PreferencesService(dir).ready()).editor.tabSize).toBe(2);
  });

  it('resets one section', async () => {
    registerPreferencesChannels(new PreferencesService(dir));
    await invoke('preferences.update', { patch: { editor: { tabSize: 8 }, http: { userAgent: 'Keep/1' } } });

    const result = (await invoke('preferences.reset', { section: 'editor' })) as {
      value: { preferences: PreferencesWire };
    };
    expect(result.value.preferences.editor.tabSize).toBe(DEFAULT_PREFERENCES.editor.tabSize);
    expect(result.value.preferences.http.userAgent).toBe('Keep/1');
  });

  it('rejects an unknown section rather than resetting everything', async () => {
    registerPreferencesChannels(new PreferencesService(dir));
    expect(await invoke('preferences.reset', { section: 'nonsense' })).toMatchObject({
      ok: false,
      error: { code: 'ipc-invalid-request' },
    });
  });

  /**
   * `ssl.caBundlePath` names a file main reads on every send. A renderer that could write it
   * could point main at any file on the disk, which is exactly what the pick-or-contain rule
   * exists to prevent — so the patch is refused, not filtered, and the path moves only through
   * `ssl.pickCaBundle`.
   */
  it.each([
    ['caBundlePath', { caBundlePath: '/etc/shadow' }],
    ['caBundlePickedByMain', { caBundlePickedByMain: true }],
    ['both', { caBundlePath: '/etc/shadow', caBundlePickedByMain: true }],
    ['an empty path (the old Clear button)', { caBundlePath: '' }],
  ])('rejects a patch carrying ssl.%s, and writes nothing', async (_name, ssl) => {
    const changed: PreferencesWire[] = [];
    const service = new PreferencesService(dir);
    registerPreferencesChannels(service, (next) => changed.push(next));

    const result = (await invoke('preferences.update', { patch: { ssl } })) as {
      ok: boolean;
      error?: { code: string };
    };

    expect(result).toMatchObject({ ok: false, error: { code: 'preference-read-only' } });
    expect(changed).toEqual([]);
    expect((await new PreferencesService(dir).ready()).ssl.caBundlePath).toBeUndefined();
  });

  /**
   * `git.path` names an executable main *executes* on the tree it opens — a stricter reason
   * than the CA bundle's "reads on every send" — so it is refused exactly the same way, and the
   * path moves only through `git.locate`.
   */
  it.each([
    ['path', { path: '/usr/bin/git' }],
    ['pathPickedByMain', { pathPickedByMain: true }],
    ['both', { path: '/usr/bin/git', pathPickedByMain: true }],
  ])('refuses git.%s from the renderer, and writes nothing', async (_name, git) => {
    const changed: PreferencesWire[] = [];
    const service = new PreferencesService(dir);
    registerPreferencesChannels(service, (next) => changed.push(next));

    const result = (await invoke('preferences.update', { patch: { git } })) as {
      ok: boolean;
      error?: { code: string };
    };

    expect(result).toMatchObject({ ok: false, error: { code: 'preference-read-only' } });
    expect(changed).toEqual([]);
    expect((await new PreferencesService(dir).ready()).git.path).toBeUndefined();
  });

  it('still accepts the ssl fields the renderer does own', async () => {
    registerPreferencesChannels(new PreferencesService(dir));
    const result = (await invoke('preferences.update', { patch: { ssl: { minVersion: 'TLSv1.3' } } })) as {
      value: { preferences: PreferencesWire };
    };
    expect(result.value.preferences.ssl.minVersion).toBe('TLSv1.3');
  });

  it('ignores unknown keys inside a patch', async () => {
    registerPreferencesChannels(new PreferencesService(dir));
    const result = (await invoke('preferences.update', { patch: { editor: { tabSize: 2, nonsense: 9 } } })) as {
      value: { preferences: PreferencesWire };
    };
    expect(result.value.preferences.editor).not.toHaveProperty('nonsense');
    expect(result.value.preferences.editor.tabSize).toBe(2);
  });
});
