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
import { DEFAULT_PREFERENCES, mergePreferences } from '@wirebench/engine';
import { PreferencesService, rememberPickedGit } from '../src/main/preferences.js';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { registerGitChannels } from '../src/main/ipc/git.js';
import type { GitLocation } from '../src/main/sync/git-cli.js';
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
  it('answers with the location findGit reports, using the configured preference', async () => {
    const location: GitLocation = { path: '/usr/bin/git', version: '2.40.0' };
    const findGit = vi.fn().mockResolvedValue(location);
    const preferences = new PreferencesService(dir);
    await preferences.update({ git: { path: '/configured/git' } });

    registerGitChannels({ preferences, picks: new DialogPicks(), findGit });

    const result = (await invoke('git.detect', {})) as { value: { location: GitLocation | null } };
    expect(result.value.location).toEqual(location);
    expect(findGit).toHaveBeenCalledWith({ configuredPath: '/configured/git' });
  });

  it('answers with null when no usable git is found', async () => {
    registerGitChannels({
      preferences: new PreferencesService(dir),
      picks: new DialogPicks(),
      findGit: vi.fn().mockResolvedValue(undefined),
    });

    const result = (await invoke('git.detect', {})) as { value: { location: GitLocation | null } };
    expect(result.value.location).toBeNull();
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
