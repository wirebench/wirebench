/** The running lock's heartbeat (Task 5 review I2), over stub sessions: no database needed to lose a lock. */
import { describe, expect, it, vi } from 'vitest';
import type { Session } from '../../../src/db/pool.js';
import { HELD, RunningLock, TRY_SHARED } from '../../../src/tenancy/running-lock.js';

/**
 * A session whose first query took the lock (as `openSession` runs `TRY_SHARED` in place of its pid read), and
 * which answers the heartbeat with `held()`. `queries` counts what is sent on it afterwards.
 */
function stubSession(
  pid: number,
  held: () => Promise<boolean>,
): Session & { readonly closed: () => boolean; readonly queries: string[] } {
  let closed = false;
  const queries: string[] = [];
  return {
    pid,
    first: { pid, ok: true },
    queries,
    query: <R extends Record<string, unknown>>(text: string) => {
      queries.push(text);
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
  it('takes the lock with one query per attempt: TRY_SHARED as the session first query, pid and all', async () => {
    const session = stubSession(7, () => Promise.resolve(true));
    const open = vi.fn().mockResolvedValue(session);
    const lock = await RunningLock.acquire('postgres://stub', { open, onLost: vi.fn() });
    try {
      expect(open).toHaveBeenCalledOnce();
      expect(open.mock.calls[0]![1]).toMatchObject({ text: TRY_SHARED });
      expect(TRY_SHARED).toMatch(/pg_backend_pid\(\) as pid/);
      // Nothing more was sent to take it.
      expect(session.queries).toEqual([]);
      expect(lock.pid).toBe(7);
    } finally {
      await lock.release();
    }
  });

  it('refuses with tenancy-reverting, and closes the session, when the first query did not get the lock', async () => {
    const session = { ...stubSession(8, () => Promise.resolve(true)), first: { pid: 8, ok: false } };
    let closed = false;
    session.close = () => {
      closed = true;
      return Promise.resolve();
    };
    await expect(
      RunningLock.acquire('postgres://stub', { open: () => Promise.resolve(session), onLost: vi.fn() }),
    ).rejects.toMatchObject({ code: 'tenancy-reverting' });
    expect(closed).toBe(true);
  });

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
      maxRetryDelayMs: 2,
      retakeWindowMs: 30,
      onLost: lost,
    });
    try {
      await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce());
      expect((lost.mock.calls[0]![0] as Error).message).toBe('the server-running lock was lost: connect ETIMEDOUT');
      expect(open.mock.calls.length).toBeGreaterThanOrEqual(3);
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
    // An attempt whose connect or first query never answers: bounded by connect timeout + query timeout.
    const never = () => new Promise<Session>(() => undefined);
    await expect(
      RunningLock.acquire('postgres://stub', { open: never, connectTimeoutMs: 1, queryTimeoutMs: 20, onLost: vi.fn() }),
    ).rejects.toThrow('taking the server-running lock had no answer within 21 ms');
    const first = stubSession(1, () => Promise.resolve(false));
    const open = vi.fn().mockResolvedValueOnce(first).mockImplementation(never);
    const lost = vi.fn();
    const lock = await RunningLock.acquire('postgres://stub', {
      open,
      heartbeatMs: 5,
      connectTimeoutMs: 1,
      queryTimeoutMs: 20,
      retryDelayMs: 1,
      retakeWindowMs: 1,
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

  describe('the re-take after a drop (owner ruling, 2026-10-30)', () => {
    const refused = () => Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:5432'), { code: 'ECONNREFUSED' });
    /** A lock whose first session drops at once, and whose later opens are `next`. */
    const dropping = async (next: () => Promise<Session>, options: Record<string, unknown>) => {
      const first = stubSession(1, () => Promise.reject(new Error('the connection ended')));
      const open = vi.fn().mockResolvedValueOnce(first).mockImplementation(next);
      const lost = vi.fn();
      const retaken = vi.fn();
      const lock = await RunningLock.acquire('postgres://stub', {
        open,
        heartbeatMs: 5,
        retryDelayMs: 5,
        maxRetryDelayMs: 20,
        onLost: lost,
        onRetaken: retaken,
        ...options,
      });
      return { lock, open, lost, retaken };
    };

    it('keeps trying while the database refuses connections, and takes the lock back when it returns', async () => {
      let refusals = 0;
      const back = stubSession(2, () => Promise.resolve(true));
      const { lock, lost, retaken } = await dropping(
        vi.fn(() => (++refusals <= 4 ? Promise.reject(refused()) : Promise.resolve(back))),
        { retakeWindowMs: 2_000 },
      );
      try {
        await vi.waitFor(() => expect(retaken).toHaveBeenCalledWith(2), { timeout: 2_000, interval: 5 });
        expect(refusals).toBe(5);
        expect(lost).not.toHaveBeenCalled();
      } finally {
        await lock.release();
      }
    });

    it('lets go once the window has passed with every attempt refused', async () => {
      const started = Date.now();
      const { lock, open, lost } = await dropping(
        vi.fn(() => Promise.reject(refused())),
        { retakeWindowMs: 150 },
      );
      try {
        await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 2_000, interval: 5 });
        // Not before the window (backoff 5, 10, 20, 20… ms), and not long after it.
        expect(Date.now() - started).toBeGreaterThanOrEqual(150);
        expect(Date.now() - started).toBeLessThan(1_000);
        expect(open.mock.calls.length).toBeGreaterThan(3);
        expect((lost.mock.calls[0]![0] as Error).message).toContain('ECONNREFUSED');
      } finally {
        await lock.release();
      }
    });

    it('lets go at once when a revert holds the lock, however long the window', async () => {
      const reverting = { ...stubSession(3, () => Promise.resolve(true)), first: { pid: 3, ok: false } };
      const { lock, open, lost } = await dropping(
        vi.fn(() => Promise.resolve(reverting)),
        {
          retakeWindowMs: 60_000,
        },
      );
      try {
        await vi.waitFor(() => expect(lost).toHaveBeenCalledOnce(), { timeout: 1_000, interval: 5 });
        // The first session, then one attempt that a revert answered.
        expect(open).toHaveBeenCalledTimes(2);
        expect((lost.mock.calls[0]![0] as Error).message).toContain('admin tenancy revert is running');
      } finally {
        await lock.release();
      }
    });
  });
});
