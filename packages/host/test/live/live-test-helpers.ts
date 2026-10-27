/**
 * Shared by the `LiveClient` and `LiveClients` tests (live-updates spec §11): an inbox that hands
 * items out as they arrive, and a timer queue fired by hand, so no test waits on the clock.
 * Test-only.
 */
import { expect } from 'vitest';

/** Items in arrival order; `take` claims the first unclaimed one that matches, now or when it arrives. */
export class Inbox<T> {
  /** Every item ever pushed, claimed or not, in arrival order. */
  readonly all: T[] = [];
  private readonly unclaimed: T[] = [];
  private readonly waiters: { readonly match: (item: T) => boolean; readonly resolve: (item: T) => void }[] = [];

  push(item: T): void {
    this.all.push(item);
    const index = this.waiters.findIndex((waiter) => waiter.match(item));
    if (index >= 0) {
      this.waiters.splice(index, 1)[0]?.resolve(item);
      return;
    }
    this.unclaimed.push(item);
  }

  take(match: (item: T) => boolean = () => true): Promise<T> {
    const index = this.unclaimed.findIndex(match);
    if (index >= 0) return Promise.resolve(this.unclaimed.splice(index, 1)[0] as T);
    return new Promise<T>((resolve) => {
      this.waiters.push({ match, resolve });
    });
  }
}

/** One timer the code under test armed. */
export interface ManualTimer {
  readonly ms: number;
  readonly fn: () => void;
  state: 'armed' | 'cancelled' | 'fired';
}

/** A `setTimer` whose timers only run when the test fires them. */
export interface ManualTimers {
  readonly setTimer: (fn: () => void, ms: number) => { cancel(): void };
  /** The delays of the timers still armed, in the order they were set. */
  readonly live: () => number[];
  /** The first armed timer of `ms`, now or as soon as one is set. */
  readonly armed: (ms: number) => Promise<ManualTimer>;
  /** Runs an armed timer, as the clock would. */
  readonly fire: (timer: ManualTimer) => void;
}

export function manualTimers(): ManualTimers {
  const timers: ManualTimer[] = [];
  const waiters: { readonly ms: number; readonly resolve: (timer: ManualTimer) => void }[] = [];
  return {
    setTimer: (fn, ms) => {
      const timer: ManualTimer = { ms, fn, state: 'armed' };
      timers.push(timer);
      const index = waiters.findIndex((waiter) => waiter.ms === ms);
      if (index >= 0) waiters.splice(index, 1)[0]?.resolve(timer);
      return {
        cancel: () => {
          if (timer.state === 'armed') timer.state = 'cancelled';
        },
      };
    },
    live: () => timers.filter((timer) => timer.state === 'armed').map((timer) => timer.ms),
    armed: (ms) => {
      const found = timers.find((timer) => timer.state === 'armed' && timer.ms === ms);
      if (found !== undefined) return Promise.resolve(found);
      return new Promise<ManualTimer>((resolve) => {
        waiters.push({ ms, resolve });
      });
    },
    fire: (timer) => {
      expect(timer.state).toBe('armed');
      timer.state = 'fired';
      timer.fn();
    },
  };
}
