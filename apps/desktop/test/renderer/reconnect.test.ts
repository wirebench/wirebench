import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import {
  Reconnector,
  isDrop,
  isRetryableConnectError,
  onReconnectNow,
  reconnectDelay,
  reconnectNow,
} from '../../src/renderer/features/ssh/reconnect.js';
import type { AttemptOutcome, ReconnectState } from '../../src/renderer/features/ssh/reconnect.js';

const RETRY: AttemptOutcome = { kind: 'retry', message: 'h:22: connect ETIMEDOUT' };

beforeEach(() => {
  vi.useFakeTimers();
  vi.setSystemTime(0);
});
afterEach(() => {
  vi.useRealTimers();
});

/** A reconnector whose attempts answer from `answers`, in order (the last one repeats). */
function loop(answers: AttemptOutcome[]) {
  const states: ReconnectState[] = [];
  const attempt = vi.fn(() => Promise.resolve(answers.length > 1 ? (answers.shift() as AttemptOutcome) : answers[0]!));
  const onReconnected = vi.fn();
  const r = new Reconnector({ attempt, onChange: (s) => states.push(s), onReconnected });
  return { r, attempt, onReconnected, states };
}

describe('classification', () => {
  it('only a lost connection is a drop: never a shell exit or a close here', () => {
    expect(isDrop('lost')).toBe(true);
    expect(isDrop('exit')).toBe(false);
    expect(isDrop('closed')).toBe(false);
    expect(isDrop(undefined)).toBe(false);
  });
  it('only an unreachable host is retried: never auth, a host key or a hosts-file problem', () => {
    expect(isRetryableConnectError('ssh-connect-failed')).toBe(true);
    for (const code of [
      'ssh-auth-failed',
      'ssh-host-key-new',
      'ssh-host-key-changed',
      'secret-missing',
      'ssh-host-incomplete',
      'ssh-hosts-invalid',
      'ssh-session-closed',
    ]) {
      expect(isRetryableConnectError(code)).toBe(false);
    }
  });
});

describe('backoff', () => {
  it('waits 1, 2, 4, 8, 16 seconds, then 30 for every later attempt', () => {
    expect([1, 2, 3, 4, 5, 6, 7, 50].map(reconnectDelay)).toEqual([
      1000, 2000, 4000, 8000, 16_000, 30_000, 30_000, 30_000,
    ]);
  });

  it('tries after each wait, counting attempts, and gives up at the limit with the last reason', async () => {
    const { r, attempt, states } = loop([RETRY]);
    r.start(3);
    expect(r.current).toEqual({ kind: 'waiting', attempt: 1, limit: 3, at: 1000 });
    await vi.advanceTimersByTimeAsync(999);
    expect(attempt).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(r.current).toEqual({ kind: 'waiting', attempt: 2, limit: 3, at: 3000 });
    await vi.advanceTimersByTimeAsync(2000);
    expect(r.current).toEqual({ kind: 'waiting', attempt: 3, limit: 3, at: 7000 });
    await vi.advanceTimersByTimeAsync(4000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(r.current).toEqual({ kind: 'gave-up', attempts: 3, message: RETRY.message });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(3);
    expect(states.map((s) => s.kind)).toEqual([
      'waiting',
      'trying',
      'waiting',
      'trying',
      'waiting',
      'trying',
      'gave-up',
    ]);
  });

  it('a success goes idle and reports the reconnect', async () => {
    const { r, onReconnected } = loop([RETRY, { kind: 'open' }]);
    r.start(10);
    await vi.advanceTimersByTimeAsync(1000 + 2000);
    expect(r.current).toEqual({ kind: 'idle' });
    expect(onReconnected).toHaveBeenCalledTimes(1);
  });

  it('a stop (auth, host key) goes idle at once, with no further attempt', async () => {
    const { r, attempt, onReconnected } = loop([{ kind: 'stop' }]);
    r.start(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.current).toEqual({ kind: 'idle' });
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('an attempt that throws counts as a retryable failure', async () => {
    const attempt = vi.fn(() => Promise.reject(new Error('ipc gone')));
    const r = new Reconnector({ attempt, onChange: () => undefined });
    r.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.current).toEqual({ kind: 'gave-up', attempts: 1, message: 'ipc gone' });
  });
});

describe('cancel and retry now', () => {
  it('cancel while waiting stops every later attempt', async () => {
    const { r, attempt } = loop([RETRY]);
    r.start(10);
    r.cancel();
    expect(r.current).toEqual({ kind: 'idle' });
    await vi.advanceTimersByTimeAsync(120_000);
    expect(attempt).not.toHaveBeenCalled();
  });

  it('cancel while trying ignores what the attempt comes back with', async () => {
    let finish: (o: AttemptOutcome) => void = () => undefined;
    const attempt = vi.fn(() => new Promise<AttemptOutcome>((resolve) => (finish = resolve)));
    const onReconnected = vi.fn();
    const r = new Reconnector({ attempt, onChange: () => undefined, onReconnected });
    r.start(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.current.kind).toBe('trying');
    r.cancel();
    finish({ kind: 'open' });
    await vi.advanceTimersByTimeAsync(0);
    expect(r.current).toEqual({ kind: 'idle' });
    expect(onReconnected).not.toHaveBeenCalled();
  });

  it('retry now skips the rest of the wait, keeping the attempt number', async () => {
    const { r, attempt } = loop([RETRY]);
    r.start(10);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.current).toMatchObject({ kind: 'waiting', attempt: 2 });
    r.retryNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(r.current).toMatchObject({ kind: 'waiting', attempt: 3, at: 1000 + 4000 });
    // The skipped wait's timer never fires a second attempt 2.
    await vi.advanceTimersByTimeAsync(1999);
    expect(attempt).toHaveBeenCalledTimes(2);
  });
});

describe('wake from sleep and network back', () => {
  it('a waiting reconnect tries at once', async () => {
    const { r, attempt } = loop([{ kind: 'open' }]);
    r.start(10);
    const off = onReconnectNow(() => {
      r.wake();
    });
    reconnectNow();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(r.current).toEqual({ kind: 'idle' });
    off();
  });

  it('one that gave up starts again with a fresh count', async () => {
    const { r, attempt } = loop([RETRY, RETRY, { kind: 'open' }]);
    r.start(1);
    await vi.advanceTimersByTimeAsync(1000);
    expect(r.current.kind).toBe('gave-up');
    r.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(attempt).toHaveBeenCalledTimes(2);
    expect(r.current).toEqual({ kind: 'gave-up', attempts: 1, message: RETRY.message });
    r.wake();
    await vi.advanceTimersByTimeAsync(0);
    expect(r.current).toEqual({ kind: 'idle' });
  });

  it('an idle or cancelled tab is left alone, and an unsubscribed one hears nothing', async () => {
    const { r, attempt } = loop([{ kind: 'open' }]);
    r.wake();
    r.start(10);
    r.cancel();
    r.wake();
    const listener = vi.fn();
    onReconnectNow(listener)();
    reconnectNow();
    await vi.advanceTimersByTimeAsync(60_000);
    expect(attempt).not.toHaveBeenCalled();
    expect(listener).not.toHaveBeenCalled();
  });
});
