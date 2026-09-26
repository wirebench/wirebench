import { afterEach, describe, expect, it, vi } from 'vitest';
import { realTimer } from '../../../src/live/module.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';

describe('live-updates module wiring (§5.1)', () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.useRealTimers();
  });

  it('is registered last, after server-sync', () => {
    expect(BUILTIN_MODULES.map((m) => m.name)).toEqual(['identity', 'teams-access', 'server-sync', 'live-updates']);
  });

  it('realTimer never holds the process open', () => {
    const set = vi.spyOn(globalThis, 'setTimeout');
    const timer = realTimer(() => undefined, 60_000);
    const handle = set.mock.results[0]?.value as NodeJS.Timeout;
    expect(handle.hasRef()).toBe(false);
    timer.cancel();
  });

  it('realTimer fires once after its delay, and not at all once cancelled', () => {
    vi.useFakeTimers();
    const fired = vi.fn();
    realTimer(fired, 10_000);
    vi.advanceTimersByTime(9_999);
    expect(fired).not.toHaveBeenCalled();
    vi.advanceTimersByTime(1);
    expect(fired).toHaveBeenCalledTimes(1);

    const cancelled = vi.fn();
    realTimer(cancelled, 10_000).cancel();
    vi.advanceTimersByTime(10_000);
    expect(cancelled).not.toHaveBeenCalled();
  });
});
