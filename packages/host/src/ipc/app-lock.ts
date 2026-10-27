/**
 * The `appLock.*` IPC channels (#428). Only main turns the app lock on, after one successful prompt, so it is
 * never on where it cannot ask; `preferences.update` refuses `secrets.appLock` for the same reason. Turning it
 * off needs no prompt. The idle minutes are an ordinary preference.
 */

import { WirebenchError } from '@wirebench/engine';
import { channels } from '@wirebench/wire/ipc';
import type { AppLock } from '../app-lock.js';
import { toPreferencesWire } from '../preferences.js';
import type { PreferencesService } from '../preferences.js';
import type { PreferencesWire } from '@wirebench/wire/wire-base';
import { registerHandler, type HandlerTable } from './register.js';

export interface AppLockChannelDeps {
  readonly preferences: Pick<PreferencesService, 'update' | 'ready' | 'isLocked'>;
  readonly lock: Pick<AppLock, 'verify' | 'state'>;
  /** Whether this OS can ask, and if not, why. */
  readonly support: { readonly supported: boolean; readonly reason?: string };
  readonly onChanged?: (preferences: PreferencesWire) => void;
}

export function registerAppLockChannels(table: HandlerTable, deps: AppLockChannelDeps): void {
  registerHandler(table, channels.appLock.status, () => Promise.resolve({ ...deps.support, ...deps.lock.state() }));

  registerHandler(table, channels.appLock.set, async (request) => {
    await deps.preferences.ready();
    if (deps.preferences.isLocked('secrets.appLock')) {
      throw new WirebenchError('preference-locked', 'The app lock is set by the managed-preferences policy', {
        details: { keys: ['secrets.appLock'] },
      });
    }
    if (request.enabled) await deps.lock.verify();
    const next = toPreferencesWire(await deps.preferences.update({ secrets: { appLock: request.enabled } }));
    deps.onChanged?.(next);
    return { preferences: next };
  });
}
