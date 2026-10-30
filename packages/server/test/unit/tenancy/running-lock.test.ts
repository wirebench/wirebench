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
      expect((lost.mock.calls[0]![0] as Error).message).toBe('the server-running lock was lost: connect ETIMEDOUT');
      expect(open).toHaveBeenCalledTimes(3);
    } finally {
      await lock.release();
    }
  });

  it('counts a heartbeat that never answers as a drop within the bound, and sends no second one meanwhile', async () => {
    let heartbeats = 0;
    const first = stubSession(1, () => {
      heartbeats++;
      return new Promise<boolean>(() => undefined); // a half-open connection: no answer, no error
    });
    const second = stubSession(2, () => Promise.resolve(true));
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValueOnce(second);
    const retaken = vi.fn();
    const started = Date.now();
    const lock = await RunningLock.acquire('postgres://stub', {
      open,
      heartbeatMs: 5,
      queryTimeoutMs: 100,
      retryDelayMs: 1,
      onLost: vi.fn(),
      onRetaken: retaken,
    });
    try {
      await vi.waitFor(() => expect(retaken).toHaveBeenCalledWith(2), { timeout: 2000, interval: 5 });
      // heartbeatMs + queryTimeoutMs + retryDelayMs, with room for a loaded machine.
      expect(Date.now() - started).toBeLessThan(1000);
      // Twenty ticks passed while the first heartbeat was out; none of them sent another.
      expect(heartbeats).toBe(1);
      expect(first.closed()).toBe(true);
    } finally {
      await lock.release();
    }
  });

  it('bounds TRY_SHARED too, and names the lock in the error onLost gets', async () => {
    const hung: Session = {
      ...stubSession(3, () => Promise.resolve(true)),
      query: () => new Promise(() => undefined),
    };
    await expect(
      RunningLock.acquire('postgres://stub', {
        open: () => Promise.resolve(hung),
        queryTimeoutMs: 20,
        onLost: vi.fn(),
      }),
    ).rejects.toThrow('taking the server-running lock had no answer within 20 ms');
    const first = stubSession(1, () => Promise.resolve(false));
    const open = vi.fn().mockResolvedValueOnce(first).mockResolvedValue(hung);
    const lost = vi.fn();
    const lock = await RunningLock.acquire('postgres://stub', {
      open,
      heartbeatMs: 5,
      queryTimeoutMs: 20,
      retryDelayMs: 1,
      retries: 1,
      label: 'the app connection',
      onLost: lost,
    });
    try {
      await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
      expect((lost.mock.calls[0]![0] as Error).message).toMatch(
        /^the server-running lock \(the app connection\) was lost: taking the server-running lock had no answer/,
      );
    } finally {
      await lock.release();
    }
  });
});
