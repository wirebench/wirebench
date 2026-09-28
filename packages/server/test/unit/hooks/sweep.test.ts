import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it } from 'vitest';
import type { Querier } from '../../../src/context.js';
import { CaptureSweeper, SWEEP_BATCH, SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';

const NOW = new Date('2026-09-28T10:00:00.000Z');
const DAY = 24 * 60 * 60 * 1000;

/** Answers each delete with the next row count; `hold()` keeps the next one pending until released. */
function fakeDb(counts: number[]) {
  const calls: { readonly text: string; readonly params: readonly unknown[] }[] = [];
  let gate: Promise<void> | undefined;
  let fail: Error | undefined;
  const db: Querier = {
    query: async (text, params = []) => {
      calls.push({ text, params });
      if (gate !== undefined) await gate;
      if (fail !== undefined) throw fail;
      return { rows: [], rowCount: counts.shift() ?? 0 };
    },
  };
  return {
    db,
    calls,
    hold(): () => void {
      let open: () => void = () => undefined;
      gate = new Promise((resolve) => {
        open = resolve;
      });
      return () => {
        gate = undefined;
        open();
      };
    },
    failWith(error: Error | undefined): void {
      fail = error;
    },
  };
}

function timers() {
  const armed: { readonly fn: () => void; readonly ms: number; cancelled: boolean }[] = [];
  return {
    setTimer: (fn: () => void, ms: number) => {
      const timer = { fn, ms, cancelled: false };
      armed.push(timer);
      return {
        cancel: () => {
          timer.cancelled = true;
        },
      };
    },
    live: () => armed.filter((timer) => !timer.cancelled),
    fire: () => {
      const due = armed.filter((timer) => !timer.cancelled);
      for (const timer of due) {
        timer.cancelled = true;
        timer.fn();
      }
    },
  };
}

function log(warnings: unknown[]): FastifyBaseLogger {
  const quiet = (): void => undefined;
  const logger = {
    level: 'warn',
    fatal: quiet,
    error: quiet,
    info: quiet,
    debug: quiet,
    trace: quiet,
    silent: quiet,
    warn: (...args: unknown[]) => {
      warnings.push(args);
    },
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
}

async function flush(): Promise<void> {
  for (let i = 0; i < 50; i += 1) await Promise.resolve();
}

describe('CaptureSweeper (webhook-capture §3.4)', () => {
  it('sweeps at start, in batches until one comes back short, with a strict cutoff maxAgeDays back', async () => {
    const f = fakeDb([SWEEP_BATCH, SWEEP_BATCH, 3]);
    const t = timers();
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log([]) });
    sweeper.start();
    await flush();
    expect(f.calls).toHaveLength(3);
    for (const call of f.calls) {
      expect(call.text).toContain('received_at < $1');
      expect(call.params).toEqual([new Date(NOW.getTime() - 7 * DAY), SWEEP_BATCH]);
    }
    expect(t.live().map((timer) => timer.ms)).toEqual([SWEEP_INTERVAL_MS]);
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(4);
    expect(t.live().map((timer) => timer.ms)).toEqual([SWEEP_INTERVAL_MS]);
  });

  it('logs a failed sweep and still sweeps at the next interval', async () => {
    const f = fakeDb([]);
    const t = timers();
    const warnings: unknown[] = [];
    f.failWith(new Error('connection lost'));
    const sweeper = new CaptureSweeper({
      db: f.db,
      maxAgeDays: 7,
      now: () => NOW,
      setTimer: t.setTimer,
      log: log(warnings),
    });
    sweeper.start();
    await flush();
    expect(warnings).toHaveLength(1);
    f.failWith(undefined);
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(2);
    expect(warnings).toHaveLength(1);
  });

  it('never runs two sweeps at once', async () => {
    const f = fakeDb([0]);
    const t = timers();
    const release = f.hold();
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log([]) });
    const first = sweeper.runOnce();
    expect(sweeper.runOnce()).toBe(first);
    release();
    await expect(first).resolves.toBe(0);
    expect(f.calls).toHaveLength(1);
  });

  it('stop cancels the timer, waits for the batch under way, and starts no other', async () => {
    const f = fakeDb([SWEEP_BATCH, SWEEP_BATCH]);
    const t = timers();
    const release = f.hold();
    const sweeper = new CaptureSweeper({ db: f.db, maxAgeDays: 7, now: () => NOW, setTimer: t.setTimer, log: log([]) });
    sweeper.start();
    await flush();
    let stopped = false;
    const stopping = sweeper.stop().then(() => {
      stopped = true;
    });
    await flush();
    expect(stopped).toBe(false);
    expect(t.live()).toEqual([]);
    release();
    await stopping;
    expect(f.calls).toHaveLength(1); // a full batch, but stopped: no second one
    t.fire();
    await flush();
    expect(f.calls).toHaveLength(1);
  });
});
