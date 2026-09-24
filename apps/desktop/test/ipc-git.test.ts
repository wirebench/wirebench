// @vitest-environment node
/**
 * `git.detect` / `git.locate` / `git.clearPath`: like `ssl.pickCaBundle`/`clearCaBundle`, the
 * only routes by which the `git.path` preference changes. `findGit` is stubbed through an
 * injected dep so these tests never spawn a real process; the picker goes through the real
 * `pickFile` (native-dialogs.ts), short-circuited by its `WIREBENCH_E2E_FILE_DIALOG_PATH`
 * override exactly as a Playwright run would drive it.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, findGit, mergePreferences } from '@wirebench/engine';
import type { GitLocation, Runner } from '@wirebench/engine';
import {
  configuredGitPath,
  gitLocatorOptions,
  PreferencesService,
  rememberPickedGit,
} from '../src/main/preferences.js';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { registerGitChannels } from '../src/main/ipc/git.js';
import type { PreferencesWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

const showOpenDialog = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  app: { isPackaged: false },
  BrowserWindow: { fromWebContents: () => null },
  dialog: { showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) as unknown },
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
  showOpenDialog.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'wirebench-git-ipc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'];
});

describe('git.detect', () => {
  it('answers with whatever the injected locator reports', async () => {
    const location: GitLocation = { path: '/usr/bin/git', version: '2.40.0' };
    const locate = vi.fn().mockResolvedValue(location);

    registerGitChannels({ preferences: new PreferencesService(dir), picks: new DialogPicks(), locate });

    const result = (await invoke('git.detect', {})) as { value: { location: GitLocation | null } };
    expect(result.value.location).toEqual(location);
    expect(locate).toHaveBeenCalledWith();
  });

  it('answers with null when the locator finds nothing', async () => {
    registerGitChannels({
      preferences: new PreferencesService(dir),
      picks: new DialogPicks(),
      locate: vi.fn().mockResolvedValue(undefined),
    });

    const result = (await invoke('git.detect', {})) as { value: { location: GitLocation | null } };
    expect(result.value.location).toBeNull();
  });

  /**
   * The bug fix round 2 caught: `git.detect` used to resolve `configuredGitPath` itself and pass
   * it straight to `findGit`, which bypasses whatever precedence (including the e2e "no git"
   * override) the injected locator applies. `git.detect` must apply no configured-path logic of
   * its own — the locator is the *only* discovery path it calls, marked preference or not.
   */
  it('uses only the injected locator, never findGit directly, even with a marked preference configured', async () => {
    const overrideResult: GitLocation = { path: '/nonexistent/git-does-not-resolve', version: '0.0.0-override' };
    const locate = vi.fn().mockResolvedValue(overrideResult);
    const findGit = vi.fn().mockResolvedValue({ path: '/configured/git', version: '2.40.0' });
    const preferences = new PreferencesService(dir);
    // A marked preference is configured — the very case the bug let bypass the locator.
    await preferences.update({ git: { path: '/configured/git', pathPickedByMain: true } });

    registerGitChannels({ preferences, picks: new DialogPicks(), locate, findGit });

    const result = (await invoke('git.detect', {})) as { value: { location: GitLocation | null } };
    expect(result.value.location).toEqual(overrideResult);
    expect(locate).toHaveBeenCalledTimes(1);
    expect(findGit).not.toHaveBeenCalled();
  });

  it('still returns a marked path when the locator itself resolves it (no override configured)', async () => {
    const markedLocation: GitLocation = { path: '/configured/git', version: '2.41.0' };
    const locate = vi.fn().mockResolvedValue(markedLocation);
    const preferences = new PreferencesService(dir);
    await preferences.update({ git: { path: '/configured/git', pathPickedByMain: true } });

    registerGitChannels({ preferences, picks: new DialogPicks(), locate });

    const result = (await invoke('git.detect', {})) as { value: { location: GitLocation | null } };
    expect(result.value.location).toEqual(markedLocation);
  });
});

describe('git.locate', () => {
  it('records the pick, persists the path with its marker, and broadcasts', async () => {
    const picked = '/opt/homebrew/bin/git';
    process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'] = picked;
    const location: GitLocation = { path: picked, version: '2.41.0' };
    const picks = new DialogPicks();
    const changed: PreferencesWire[] = [];
    registerGitChannels({
      preferences: new PreferencesService(dir),
      picks,
      locate: vi.fn(),
      findGit: vi.fn().mockResolvedValue(location),
      onChanged: (next) => changed.push(next),
    });

    const result = (await invoke('git.locate', {})) as {
      value: { location: GitLocation; preferences: PreferencesWire };
    };

    expect(result.value.location).toEqual(location);
    expect(result.value.preferences.git.path).toBe(picked);
    expect(result.value.preferences.git.pathPickedByMain).toBe(true);
    expect(picks.hasRead(picked)).toBe(true);
    expect(changed).toHaveLength(1);
    const reloaded = await new PreferencesService(dir).ready();
    expect(reloaded.git.path).toBe(picked);
    expect(reloaded.git.pathPickedByMain).toBe(true);
  });

  it('fails with git-not-found when the picked file is not a usable git, and writes nothing', async () => {
    process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'] = '/not/git';
    const changed: PreferencesWire[] = [];
    registerGitChannels({
      preferences: new PreferencesService(dir),
      picks: new DialogPicks(),
      locate: vi.fn(),
      findGit: vi.fn().mockResolvedValue(undefined),
      onChanged: (next) => changed.push(next),
    });

    const result = (await invoke('git.locate', {})) as { ok: boolean; error?: { code: string } };
    expect(result).toMatchObject({ ok: false, error: { code: 'git-not-found' } });
    expect(changed).toEqual([]);
    expect((await new PreferencesService(dir).ready()).git.path).toBeUndefined();
  });

  it('changes nothing when the user cancels the dialog', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const changed: PreferencesWire[] = [];
    const findGit = vi.fn();
    registerGitChannels({
      preferences: new PreferencesService(dir),
      picks: new DialogPicks(),
      locate: vi.fn(),
      findGit,
      onChanged: (next) => changed.push(next),
    });

    const result = (await invoke('git.locate', {})) as { value: { location?: GitLocation } };
    expect(result.value.location).toBeUndefined();
    expect(changed).toEqual([]);
    expect(findGit).not.toHaveBeenCalled();
    expect((await new PreferencesService(dir).ready()).git.path).toBeUndefined();
  });
});

describe('git.clearPath', () => {
  it('clears the path and its marker together', async () => {
    const picked = '/opt/git';
    process.env['WIREBENCH_E2E_FILE_DIALOG_PATH'] = picked;
    const preferences = new PreferencesService(dir);
    const changed: PreferencesWire[] = [];
    registerGitChannels({
      preferences,
      picks: new DialogPicks(),
      locate: vi.fn(),
      findGit: vi.fn().mockResolvedValue({ path: picked, version: '2.40.0' }),
      onChanged: (next) => changed.push(next),
    });
    await invoke('git.locate', {});

    const result = (await invoke('git.clearPath', {})) as { value: { preferences: PreferencesWire } };

    expect(result.value.preferences.git.path).toBe('');
    expect(result.value.preferences.git.pathPickedByMain).toBe(false);
    expect(changed).toHaveLength(2);
    const reloaded = await new PreferencesService(dir).ready();
    expect(reloaded.git.path).toBe('');
    expect(reloaded.git.pathPickedByMain).toBe(false);
  });
});

describe('rememberPickedGit', () => {
  it('records no pick for a hand-edited preferences file with a path but no marker', () => {
    const picks = new DialogPicks();
    const preferences = mergePreferences({ git: { path: '/etc/evil/git' } });

    expect(rememberPickedGit(preferences, picks)).toBeUndefined();
    expect(picks.hasRead('/etc/evil/git')).toBe(false);
  });

  it('records a pick for a path main itself picked', () => {
    const picks = new DialogPicks();
    const preferences = mergePreferences({ git: { path: '/opt/git', pathPickedByMain: true } });

    expect(rememberPickedGit(preferences, picks)).toBe('/opt/git');
    expect(picks.hasRead('/opt/git')).toBe(true);
  });

  it('records nothing when no path is configured at all', () => {
    const picks = new DialogPicks();
    expect(rememberPickedGit(DEFAULT_PREFERENCES, picks)).toBeUndefined();
  });
});

describe('configuredGitPath', () => {
  it('is undefined for an unmarked path', () => {
    expect(configuredGitPath(mergePreferences({ git: { path: '/hand/edited/git' } }))).toBeUndefined();
  });

  it('is undefined for a marked but empty path (the clearPath tombstone)', () => {
    expect(configuredGitPath(mergePreferences({ git: { path: '', pathPickedByMain: true } }))).toBeUndefined();
  });

  it('is the path when marked and non-empty', () => {
    expect(configuredGitPath(mergePreferences({ git: { path: '/opt/git', pathPickedByMain: true } }))).toBe('/opt/git');
  });

  it('is undefined when nothing is configured at all', () => {
    expect(configuredGitPath(DEFAULT_PREFERENCES)).toBeUndefined();
  });
});

describe('gitLocatorOptions', () => {
  /**
   * The bug Task 15's e2e run found: `WIREBENCH_E2E_GIT_PATH=/nonexistent/git` (simulating "no
   * git installed") must make discovery see *only* that path — not fall through to PATH or the
   * platform defaults, which a real CI runner or dev machine has a usable git on.
   */
  it('restricts findGit to only the override when it is set and the app is unpackaged', async () => {
    const seen: string[] = [];
    const run: Runner = (file) => {
      seen.push(file);
      return Promise.resolve({ stdout: '', stderr: '', exitCode: 127 });
    };

    const options = gitLocatorOptions({
      env: { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git', PATH: '/usr/bin:/opt/homebrew/bin' },
      isPackaged: false,
      preferences: DEFAULT_PREFERENCES,
    });
    const location = await findGit({ ...options, platform: 'darwin', run });

    expect(location).toBeUndefined();
    expect(seen).toEqual(['/nonexistent/git']);
  });

  it('ignores the override when the app is packaged, falling back to the marked preference path', () => {
    const options = gitLocatorOptions({
      env: { WIREBENCH_E2E_GIT_PATH: '/nonexistent/git' },
      isPackaged: true,
      preferences: mergePreferences({ git: { path: '/opt/git', pathPickedByMain: true } }),
    });

    expect(options).toEqual({ configuredPath: '/opt/git' });
  });

  it('falls back to the marked preference path when no override is set', () => {
    const options = gitLocatorOptions({
      env: {},
      isPackaged: false,
      preferences: mergePreferences({ git: { path: '/opt/git', pathPickedByMain: true } }),
    });

    expect(options).toEqual({ configuredPath: '/opt/git' });
  });

  it('ignores an unmarked preference path, leaving discovery to findGit', () => {
    const options = gitLocatorOptions({
      env: {},
      isPackaged: false,
      preferences: mergePreferences({ git: { path: '/hand/edited/git' } }),
    });

    expect(options).toEqual({});
  });

  it('returns no configured path when nothing is set at all', () => {
    const options = gitLocatorOptions({ env: {}, isPackaged: false, preferences: DEFAULT_PREFERENCES });
    expect(options).toEqual({});
  });
});
