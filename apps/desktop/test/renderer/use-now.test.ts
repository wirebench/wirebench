import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { act, cleanup, renderHook } from '@testing-library/react';
import { useNow } from '../../src/renderer/features/sync/use-now.js';

describe('useNow', () => {
  beforeEach(() => {
    vi.useFakeTimers();
  });
  afterEach(() => {
    cleanup();
    vi.useRealTimers();
  });

  it('advances after the interval elapses', () => {
    const { result } = renderHook(() => useNow(1000));
    const first = result.current;

    act(() => {
      vi.advanceTimersByTime(1000);
    });

    expect(result.current.getTime()).toBeGreaterThan(first.getTime());
  });

  it('does not schedule a timer for a non-positive interval', () => {
    const baseline = vi.getTimerCount();
    const { unmount } = renderHook(() => useNow(0));

    expect(vi.getTimerCount()).toBe(baseline);
    unmount();
  });

  it('clears its timer on unmount', () => {
    const baseline = vi.getTimerCount();
    const { unmount } = renderHook(() => useNow(1000));

    expect(vi.getTimerCount()).toBe(baseline + 1);
    unmount();
    expect(vi.getTimerCount()).toBe(baseline);
  });
});
