/**
 * `ssl.pickCaBundle` / `ssl.clearCaBundle`: the only route by which the CA bundle preference
 * changes.
 *
 * The point of the channel is containment, so these tests watch two things together — what was
 * persisted, and whether the path entered the session's read-pick set. A path that is persisted
 * without being picked is trusted by nothing; a path that is picked without the
 * `caBundlePickedByMain` marker is forgotten at the next startup (see `rememberPickedCaBundle`).
 */

import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { DEFAULT_PREFERENCES, mergePreferences } from '@wirebench/engine';
import { DialogPicks } from '../src/main/dialog-picks.js';
import { PREFERENCES_FILE, PreferencesService, rememberPickedCaBundle } from '../src/main/preferences.js';
import { registerSslChannels } from '../src/main/ipc/ssl.js';
import type { PreferencesWire } from '../src/shared/wire-types.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();

/** `showOpenDialog` is never reached in these tests — the e2e override stands in for the dialog. */
const showOpenDialog = vi.fn();

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
  BrowserWindow: { fromWebContents: () => null },
  dialog: {
    showOpenDialog: (...args: unknown[]) => showOpenDialog(...args) as unknown,
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
  showOpenDialog.mockReset();
  dir = mkdtempSync(join(tmpdir(), 'wirebench-ssl-ipc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
  delete process.env['WIREBENCH_E2E_OPEN_PATH'];
});

describe('ssl.pickCaBundle', () => {
  it('records the pick, persists the path with its marker, and broadcasts', async () => {
    const bundle = join(dir, 'corp-ca.pem');
    writeFileSync(bundle, '-----BEGIN CERTIFICATE-----\n', 'utf8');
    process.env['WIREBENCH_E2E_OPEN_PATH'] = bundle;
    const picks = new DialogPicks();
    const changed: PreferencesWire[] = [];
    registerSslChannels({
      preferences: new PreferencesService(dir),
      picks,
      onChanged: (next) => changed.push(next),
    });

    const result = (await invoke('ssl.pickCaBundle', {})) as {
      value: { path?: string; preferences: PreferencesWire };
    };

    expect(result.value.path).toBe(bundle);
    expect(result.value.preferences.ssl.caBundlePath).toBe(bundle);
    expect(result.value.preferences.ssl.caBundlePickedByMain).toBe(true);
    expect(picks.hasRead(bundle)).toBe(true);
    expect(changed).toHaveLength(1);
    // Persisted, so the next session sees it — with the marker that makes it re-pickable.
    const reloaded = await new PreferencesService(dir).ready();
    expect(reloaded.ssl.caBundlePath).toBe(bundle);
    expect(reloaded.ssl.caBundlePickedByMain).toBe(true);
  });

  it('changes nothing when the user cancels the dialog', async () => {
    showOpenDialog.mockResolvedValue({ canceled: true, filePaths: [] });
    const picks = new DialogPicks();
    const changed: PreferencesWire[] = [];
    registerSslChannels({ preferences: new PreferencesService(dir), picks, onChanged: (n) => changed.push(n) });

    const result = (await invoke('ssl.pickCaBundle', {})) as { value: { path?: string } };

    expect(result.value.path).toBeUndefined();
    expect(changed).toEqual([]);
    expect((await new PreferencesService(dir).ready()).ssl.caBundlePath).toBeUndefined();
  });
});

describe('ssl.clearCaBundle', () => {
  it('clears the path and its marker together', async () => {
    const bundle = join(dir, 'corp-ca.pem');
    writeFileSync(bundle, '-----BEGIN CERTIFICATE-----\n', 'utf8');
    process.env['WIREBENCH_E2E_OPEN_PATH'] = bundle;
    const changed: PreferencesWire[] = [];
    registerSslChannels({
      preferences: new PreferencesService(dir),
      picks: new DialogPicks(),
      onChanged: (next) => changed.push(next),
    });
    await invoke('ssl.pickCaBundle', {});

    const result = (await invoke('ssl.clearCaBundle', {})) as { value: { preferences: PreferencesWire } };

    expect(result.value.preferences.ssl.caBundlePath).toBe('');
    expect(result.value.preferences.ssl.caBundlePickedByMain).toBe(false);
    expect(changed).toHaveLength(2);
    const reloaded = await new PreferencesService(dir).ready();
    expect(rememberPickedCaBundle(reloaded, new DialogPicks())).toBeUndefined();
  });
});

describe('rememberPickedCaBundle', () => {
  /**
   * The adversarial case the whole marker exists for: someone edits `preferences.yaml` by hand
   * (or anything else writes a path into it) and restarts. Without a main-set marker the path
   * gets no read pick, so `ProjectService.trustAnchors` refuses to read it.
   */
  it('records no pick for a hand-edited preferences file with a path but no marker', async () => {
    writeFileSync(
      join(dir, PREFERENCES_FILE),
      'version: 1\nssl:\n  caBundlePath: /etc/evil/ca.pem\n  minVersion: TLSv1.2\n  trustAll: false\n',
      'utf8',
    );
    const loaded = await new PreferencesService(dir).ready();
    expect(loaded.ssl.caBundlePath).toBe('/etc/evil/ca.pem');

    const picks = new DialogPicks();
    expect(rememberPickedCaBundle(loaded, picks)).toBeUndefined();
    expect(picks.hasRead('/etc/evil/ca.pem')).toBe(false);
  });

  it('records a pick for a path main itself picked', () => {
    const picks = new DialogPicks();
    const preferences = mergePreferences({ ssl: { caBundlePath: '/opt/ca.pem', caBundlePickedByMain: true } });

    expect(rememberPickedCaBundle(preferences, picks)).toBe('/opt/ca.pem');
    expect(picks.hasRead('/opt/ca.pem')).toBe(true);
  });

  it('records nothing when no bundle is configured at all', () => {
    const picks = new DialogPicks();
    expect(rememberPickedCaBundle(DEFAULT_PREFERENCES, picks)).toBeUndefined();
  });
});
