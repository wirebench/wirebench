/**
 * `appLock.status` / `appLock.set` (#428): main turns the app lock on only after a prompt the person passes,
 * and `preferences.update` refuses `secrets.appLock`, so nothing else can.
 */

import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import { PreferencesService } from '../src/preferences.js';
import { registerAppLockChannels } from '../src/ipc/app-lock.js';
import { registerPreferencesChannels } from '../src/ipc/preferences.js';
import type { PreferencesWire } from '@wirebench/wire/wire-base';
import { tableInto } from './helpers/ipc-table.js';

const handlers = new Map<string, (event: unknown, payload: unknown) => Promise<unknown>>();
const table = tableInto(handlers);

vi.mock('electron', () => ({
  ipcMain: {
    handle: (name: string, handler: (event: unknown, payload: unknown) => Promise<unknown>) => {
      handlers.set(name, handler);
    },
  },
}));

function invoke(channel: string, payload: unknown): Promise<unknown> {
  const handler = handlers.get(channel);
  if (handler === undefined) throw new Error(`no handler registered for ${channel}`);
  return handler({ sender: {} }, payload);
}

let dir: string;
beforeEach(() => {
  handlers.clear();
  dir = mkdtempSync(join(tmpdir(), 'wirebench-app-lock-ipc-'));
});
afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function register(verify: () => Promise<void>) {
  const preferences = new PreferencesService(dir);
  const changed: PreferencesWire[] = [];
  const lock = { verify: vi.fn(verify), state: () => ({ active: false, locked: false }) };
  registerAppLockChannels(table, {
    preferences,
    lock,
    support: { supported: true },
    onChanged: (next) => changed.push(next),
  });
  registerPreferencesChannels(table, preferences);
  return { preferences, lock, changed };
}

describe('appLock.set', () => {
  it('turns the lock on only after the prompt, and persists it', async () => {
    const { lock, changed } = register(() => Promise.resolve());
    const result = (await invoke('appLock.set', { enabled: true })) as { value: { preferences: PreferencesWire } };
    expect(lock.verify).toHaveBeenCalledTimes(1);
    expect(result.value.preferences.secrets.appLock).toBe(true);
    expect(changed).toHaveLength(1);
    expect((await new PreferencesService(dir).ready()).secrets.appLock).toBe(true);
  });

  it('leaves it off when the prompt is not passed', async () => {
    const { changed } = register(() =>
      Promise.reject(
        new WirebenchError('app-locked', 'The app lock was not turned on', { details: { reason: 'cancelled' } }),
      ),
    );
    const result = (await invoke('appLock.set', { enabled: true })) as { ok: boolean; error: { code: string } };
    expect(result).toMatchObject({ ok: false, error: { code: 'app-locked' } });
    expect(changed).toHaveLength(0);
    expect((await new PreferencesService(dir).ready()).secrets.appLock).toBe(false);
  });

  it('turns it off without a prompt', async () => {
    const { lock } = register(() => Promise.resolve());
    await invoke('appLock.set', { enabled: true });
    const result = (await invoke('appLock.set', { enabled: false })) as { value: { preferences: PreferencesWire } };
    expect(result.value.preferences.secrets.appLock).toBe(false);
    expect(lock.verify).toHaveBeenCalledTimes(1);
  });

  it('is refused through preferences.update, while the idle minutes are not', async () => {
    register(() => Promise.resolve());
    const refused = (await invoke('preferences.update', { patch: { secrets: { appLock: true } } })) as {
      ok: boolean;
      error: { code: string };
    };
    expect(refused).toMatchObject({ ok: false, error: { code: 'preference-read-only' } });
    const idle = (await invoke('preferences.update', { patch: { secrets: { appLockIdleMinutes: 30 } } })) as {
      value: { preferences: PreferencesWire };
    };
    expect(idle.value.preferences.secrets.appLockIdleMinutes).toBe(30);
  });

  it('reports what this OS supports with the lock state', async () => {
    register(() => Promise.resolve());
    await expect(invoke('appLock.status', undefined)).resolves.toMatchObject({
      value: { supported: true, active: false, locked: false },
    });
  });
});
