/** The running lock's heartbeat (Task 5 review I2), over stub sessions: no database needed to lose a lock. */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../src/db/pool.js';
import { HELD, RunningLock, TRY_SHARED } from '../../../src/tenancy/running-lock.js';

/** A session that takes the lock, and answers the heartbeat with `held()`. */
function stubSession(pid: number, held: () => Promise<boolean>): Session & { readonly closed: () => boolean } {
  let closed = false;
  return {
    pid,
    query: <R extends Record<string, unknown>>(text: string) => {
      if (text === TRY_SHARED) return Promise.resolve({ rows: [{ ok: true }] as unknown as R[], rowCount: 1 });
      if (text === HELD) return held().then((value) => ({ rows: [{ held: value }] as unknown as R[], rowCount: 1 }));
      return Promise.reject(new Error(`unexpected ${text}`));
    },
    onLost: () => undefined,
    close: () => {
      closed = true;
      return Promise.resolve();
    },
    closed: () => closed,
  };
}

describe('the running-lock heartbeat', () => {
  it('takes the lock again when the session answers that it no longer holds it (a half-open connection)', async () => {
    const first = stubSession(1, () => Promise.resolve(false));
    const second = stubSession(2, () => Promise.resolve(true));
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const retaken = vi.fn();
    const lost = vi.fn();
    const lock = await RunningLock.acquire('postgres://stub', {
      open,
      heartbeatMs: 5,
      retryDelayMs: 1,
      onLost: lost,
      onRetaken: retaken,
    });
    try {
      await vi.waitFor(() => expect(retaken).toHaveBeenCalledWith(2));
      expect(first.closed()).toBe(true);
      expect(lock.pid).toBe(2);
      expect(lost).not.toHaveBeenCalled();
    } finally {
      await lock.release();
    }
    expect(second.closed()).toBe(true);
  });

  it('treats a heartbeat that fails as a drop, and calls onLost once no new connection opens', async () => {
    const first = stubSession(1, () => Promise.reject(new Error('connection timed out')));
    const open = vi.fn().mockResolvedValueOnce(first).mockRejectedValue(new Error('connect ETIMEDOUT'));
    const lost = vi.fn();
    const lock = await RunningLock.acquire('postgres://stub', {
      open,
      heartbeatMs: 5,
      retryDelayMs: 1,
      retries: 2,
      onLost: lost,
    });
    try {
      await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
      expect((lost.mock.calls[0]![0] as Error).message).toBe('connect ETIMEDOUT');
      expect(open).toHaveBeenCalledTimes(3);
    } finally {
      await lock.release();
    }
  });
});
