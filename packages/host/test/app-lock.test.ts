// @vitest-environment node
import { describe, expect, it, vi } from 'vitest';
import { AppLock, lockedGetter } from '../src/app-lock.js';
import type { AppLockDeps } from '../src/app-lock.js';

function lock(overrides: Partial<AppLockDeps> = {}) {
  let idle = 0;
  const unlock = vi.fn<(reason: string) => Promise<void>>(() => Promise.resolve());
  const log = vi.fn();
  const appLock = new AppLock({
    enabled: () => true,
    idleMinutes: () => 15,
    supported: true,
    idleSeconds: () => idle,
    unlock,
    log,
    ...overrides,
  });
  return {
    appLock,
    unlock,
    log,
    idle: (seconds: number) => {
      idle = seconds;
    },
  };
}

const cancelled = Object.assign(new Error('cancelled'), { reason: 'cancelled' });

describe('AppLock', () => {
  it('is locked at launch, asks once, then stays unlocked', async () => {
    const { appLock, unlock } = lock();
    expect(appLock.state()).toEqual({ active: true, locked: true });
    await appLock.ensureUnlocked();
    await appLock.ensureUnlocked();
    expect(unlock).toHaveBeenCalledTimes(1);
    expect(unlock).toHaveBeenCalledWith('use SSH secrets');
    expect(appLock.state().locked).toBe(false);
  });

  it('never asks when the preference is off', async () => {
    const { appLock, unlock } = lock({ enabled: () => false });
    await appLock.ensureUnlocked();
    expect(unlock).not.toHaveBeenCalled();
    expect(appLock.state()).toEqual({ active: false, locked: false });
  });

  it('shares one prompt between reads waiting at the same time', async () => {
    let finish: () => void = () => undefined;
    const unlock = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finish = resolve;
        }),
    );
    const { appLock } = lock({ unlock });
    const reads = [appLock.ensureUnlocked(), appLock.ensureUnlocked(), appLock.ensureUnlocked()];
    finish();
    await Promise.all(reads);
    expect(unlock).toHaveBeenCalledTimes(1);
  });

  it('stays locked and refuses when the prompt is cancelled, and asks again next time', async () => {
    const unlock = vi.fn().mockRejectedValueOnce(cancelled).mockResolvedValueOnce(undefined);
    const { appLock } = lock({ unlock });
    await expect(appLock.ensureUnlocked()).rejects.toMatchObject({
      code: 'app-locked',
      details: { reason: 'cancelled' },
    });
    expect(appLock.state().locked).toBe(true);
    await appLock.ensureUnlocked();
    expect(unlock).toHaveBeenCalledTimes(2);
  });

  it('locks again after the idle time, and on lock()', async () => {
    const { appLock, idle } = lock({ idleMinutes: () => 5 });
    await appLock.ensureUnlocked();
    idle(299);
    appLock.tick();
    expect(appLock.state().locked).toBe(false);
    idle(300);
    appLock.tick();
    expect(appLock.state().locked).toBe(true);
    await appLock.ensureUnlocked();
    appLock.lock();
    expect(appLock.state().locked).toBe(true);
  });

  it('is ignored where the OS cannot ask, with one log line', async () => {
    const { appLock, unlock, log } = lock({ supported: false });
    await appLock.ensureUnlocked();
    await appLock.ensureUnlocked();
    expect(unlock).not.toHaveBeenCalled();
    expect(log).toHaveBeenCalledTimes(1);
    await expect(appLock.verify()).rejects.toMatchObject({ code: 'app-locked', details: { reason: 'unsupported' } });
  });

  it('verifies with one prompt before turning on, which unlocks too', async () => {
    const { appLock, unlock } = lock();
    await appLock.verify();
    expect(unlock).toHaveBeenCalledWith('turn on the app lock');
    expect(appLock.state().locked).toBe(false);
    const refused = lock({ unlock: vi.fn().mockRejectedValue(cancelled) });
    await expect(refused.appLock.verify()).rejects.toMatchObject({ details: { reason: 'cancelled' } });
  });
});

describe('lockedGetter', () => {
  it('waits for the lock before reading, and reads nothing when it refuses', async () => {
    const get = vi.fn((name: string) => Promise.resolve(`value of ${name}`));
    const { appLock } = lock({ unlock: vi.fn().mockRejectedValue(cancelled) });
    await expect(lockedGetter(appLock, get)('X')).rejects.toMatchObject({ code: 'app-locked' });
    expect(get).not.toHaveBeenCalled();
    const open = lock();
    await expect(lockedGetter(open.appLock, get)('X')).resolves.toBe('value of X');
    expect(lockedGetter(undefined, get)).toBe(get);
  });
});
