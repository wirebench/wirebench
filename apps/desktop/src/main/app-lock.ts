import { WirebenchError } from '@wirebench/engine';

/**
 * The app lock (#428): when the `secrets.appLock` preference is on, an SSH secret is read only after the
 * person has proved they are at the machine (biometrics or the OS password). Locked at launch, again after
 * `secrets.appLockIdleMinutes` without input anywhere on the machine, and on screen lock or suspend. Sessions
 * already open stay open; only new reads ask. Nothing outside SSH is gated.
 */

export interface AppLockDeps {
  /** The `secrets.appLock` preference, read at each check. */
  readonly enabled: () => boolean;
  readonly idleMinutes: () => number;
  /** False where this OS cannot ask (Linux): the lock then never engages, said once in the log. */
  readonly supported: boolean;
  /** Seconds since the last input anywhere on the machine (`powerMonitor.getSystemIdleTime`). */
  readonly idleSeconds: () => number;
  /**
   * Asks for the device owner with `reason`.
   *
   * @throws an error whose `reason` is `cancelled`, `unsupported` or `failed`
   */
  readonly unlock: (reason: string) => Promise<void>;
  readonly log?: (line: string) => void;
}

export interface AppLockState {
  /** On, and able to work here. */
  readonly active: boolean;
  /** The next SSH secret read will ask. */
  readonly locked: boolean;
}

const reasonOf = (error: unknown): 'cancelled' | 'unsupported' | 'failed' => {
  const why = (error as { reason?: unknown } | null)?.reason;
  return why === 'cancelled' || why === 'unsupported' ? why : 'failed';
};

export class AppLock {
  private locked = true;
  private pending: Promise<void> | undefined;
  private warned = false;

  constructor(private readonly deps: AppLockDeps) {}

  private get active(): boolean {
    if (!this.deps.enabled()) return false;
    if (this.deps.supported) return true;
    if (!this.warned) {
      this.warned = true;
      this.deps.log?.('App lock is on in the preferences, but this OS cannot ask for it; it is ignored');
    }
    return false;
  }

  state(): AppLockState {
    const active = this.active;
    return { active, locked: active && this.locked };
  }

  /** Locks now: screen lock, suspend. */
  lock(): void {
    this.locked = true;
  }

  /** Locks once the machine has been idle for the time the preference sets; called on a timer. */
  tick(): void {
    if (!this.locked && this.deps.idleSeconds() >= this.deps.idleMinutes() * 60) this.locked = true;
  }

  /**
   * Resolves once the app is unlocked, asking when it is locked. Every caller waiting at the same time shares
   * one prompt.
   *
   * @throws WirebenchError `app-locked` {reason} when the prompt is cancelled or fails
   */
  async ensureUnlocked(reason = 'use SSH secrets'): Promise<void> {
    if (!this.state().locked) return;
    this.pending ??= this.deps
      .unlock(reason)
      .then(() => {
        this.locked = false;
      })
      .finally(() => {
        this.pending = undefined;
      });
    try {
      await this.pending;
    } catch (error) {
      throw new WirebenchError('app-locked', 'Wirebench is locked; unlock it to use SSH secrets', {
        details: { reason: reasonOf(error) },
      });
    }
  }

  /**
   * One prompt before the preference turns on, so it cannot be switched on where it cannot work. It unlocks
   * the app too: the person has just proved they are here.
   *
   * @throws WirebenchError `app-locked` {reason}
   */
  async verify(): Promise<void> {
    if (!this.deps.supported) {
      throw new WirebenchError('app-locked', 'This OS cannot ask for biometrics or the password', {
        details: { reason: 'unsupported' },
      });
    }
    try {
      await this.deps.unlock('turn on the app lock');
    } catch (error) {
      throw new WirebenchError('app-locked', 'The app lock was not turned on', {
        details: { reason: reasonOf(error) },
      });
    }
    this.locked = false;
  }
}

/** A secret getter that waits for the app lock before each read while it is locked. */
export function lockedGetter<A extends unknown[], R>(
  lock: Pick<AppLock, 'ensureUnlocked'> | undefined,
  get: (...args: A) => Promise<R>,
): (...args: A) => Promise<R> {
  if (lock === undefined) return get;
  return async (...args) => {
    await lock.ensureUnlocked();
    return get(...args);
  };
}
