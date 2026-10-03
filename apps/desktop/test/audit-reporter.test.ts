import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import type { DesktopAuditBatch, DesktopAuditEvent, ServerAccount } from '@wirebench/engine';
import { AuditOutbox, outboxFor } from '../src/main/audit/outbox.js';
import { AuditReporter } from '../src/main/audit/reporter.js';

const ev = (n: number): DesktopAuditEvent => ({
  action: 'desktop.request_sent',
  details: {
    protocol: 'rest',
    method: 'GET',
    url: `https://a.example/${String(n)}`,
    status: 200,
    outcome: 'ok',
    durationMs: 1,
    environment: null,
    requestId: 'r',
    requestName: 'n',
    sentAt: '2026-10-03T10:00:00.000Z',
  },
});

class Clock {
  private timers: { id: number; at: number; fn: () => void }[] = [];
  private seq = 0;
  time = 0;
  /** Waits for the work a fired timer started, so assertions never race real file I/O. */
  idle: () => Promise<void> = () => Promise.resolve();
  setTimeout = (fn: () => void, ms: number): number => {
    const id = ++this.seq;
    this.timers.push({ id, at: this.time + ms, fn });
    return id;
  };
  clearTimeout = (id: unknown): void => {
    this.timers = this.timers.filter((t) => t.id !== id);
  };
  get pending(): number[] {
    return this.timers.map((t) => t.at - this.time);
  }
  /** Runs the next timer, advancing the clock to it. */
  async fireNext(): Promise<void> {
    this.timers.sort((a, b) => a.at - b.at);
    const t = this.timers.shift();
    if (t === undefined) throw new Error('no timer');
    this.time = t.at;
    t.fn();
    await settle();
    await this.idle();
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};
/** Polls until `ready()` holds; real file I/O on a slow runner can take more than a few turns. */
const until = async (ready: () => boolean): Promise<void> => {
  const deadline = Date.now() + 4000;
  while (!ready()) {
    if (Date.now() > deadline) throw new Error('condition never held');
    await new Promise((r) => setTimeout(r, 5));
  }
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-reporter-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

const account = (userId: string, signedOut = false): ServerAccount => ({
  url: 'https://s.example',
  userId,
  email: `${userId}@example.com`,
  displayName: userId,
  deviceName: 'laptop',
  tokenRef: 'ref',
  addedAt: '2026-10-03T09:00:00.000Z',
  ...(signedOut ? { signedOut: true } : {}),
});

function setup(
  send: (b: DesktopAuditBatch) => Promise<void> = () => Promise.resolve(),
  tokenOf: () => string | undefined = () => 'tok',
  accountsOf: () => readonly ServerAccount[] = () => [account('u1')],
) {
  const clock = new Clock();
  const batches: DesktopAuditBatch[] = [];
  const reporter = new AuditReporter({
    client: {
      reportDesktopEvents: async (_url, _token, _ws, batch) => {
        batches.push(batch);
        await send(batch);
      },
    },
    accounts: {
      tokenFor: () => Promise.resolve(tokenOf()),
      markSignedOut: () => undefined,
      list: () => accountsOf(),
    },
    now: () => new Date(clock.time),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  clock.idle = () => reporter.idle();
  reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: true });
  return { clock, batches, reporter };
}
const files = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f !== 'dropped.json');

describe('AuditReporter', () => {
  it('flushes about 2 s after an event is queued', async () => {
    const { clock, batches, reporter } = setup();
    await reporter.enqueue(ev(1), 'w1');
    expect(clock.pending).toEqual([2000]);
    expect(batches).toHaveLength(0);
    await clock.fireNext();
    expect(batches).toHaveLength(1);
    expect(await files()).toEqual([]);
  });

  it('sends 250 events as 100, 100, 50 oldest first', async () => {
    const { batches, reporter } = setup();
    for (let n = 0; n < 250; n++) await reporter.enqueue(ev(n), 'w1');
    await reporter.flush();
    expect(batches.map((b) => b.events.length)).toEqual([100, 100, 50]);
    expect(batches[0]!.events[0]).toEqual(ev(0));
    expect(batches[2]!.events[49]).toEqual(ev(249));
    expect(await files()).toEqual([]);
  });

  it('a 409 clears the outbox and stops recording until the next setTarget', async () => {
    let off = true;
    const { batches, reporter } = setup(() =>
      off ? Promise.reject(new WirebenchError('audit-desktop-recording-off', 'off')) : Promise.resolve(),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.enqueue(ev(2), 'w1');
    await reporter.flush();
    expect(await files()).toEqual([]);
    await reporter.enqueue(ev(3), 'w1');
    expect(await files()).toEqual([]);
    off = false;
    reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: true });
    await reporter.enqueue(ev(4), 'w1');
    expect(await files()).toHaveLength(1);
    expect(batches).toHaveLength(1);
  });

  it('backs off 5 s doubling to 300 s on a network failure, then retries', async () => {
    let fail = true;
    const { clock, batches, reporter } = setup(() =>
      fail ? Promise.reject(new WirebenchError('server-unreachable', 'down')) : Promise.resolve(),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(clock.pending).toEqual([5000]);
    await clock.fireNext();
    expect(clock.pending).toEqual([10000]);
    expect(await files()).toHaveLength(1);
    for (let i = 0; i < 8; i++) await clock.fireNext();
    expect(clock.pending).toEqual([300000]);
    fail = false;
    await clock.fireNext();
    expect(await files()).toEqual([]);
    expect(clock.pending).toEqual([]);
    expect(batches.length).toBeGreaterThan(2);
  });

  it('a 429 is a back-off, not a refusal: the files stay and the send is retried', async () => {
    let limited = true;
    const { clock, batches, reporter } = setup(() =>
      limited
        ? Promise.reject(new WirebenchError('audit-desktop-rate-limited', 'slow down', { details: { status: 429 } }))
        : Promise.resolve(),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(await files()).toHaveLength(1);
    expect(await new AuditOutbox(dir).dropped()).toBe(0);
    expect(clock.pending).toEqual([5000]);
    limited = false;
    await clock.fireNext();
    expect(batches.map((b) => b.events.length)).toEqual([1, 1]);
    expect(await files()).toEqual([]);
  });

  it('sends a local dropped count over the cap in clamped batches', async () => {
    const { batches, reporter } = setup();
    await outboxFor(dir).addDropped(1_500_000);
    await reporter.flush();
    expect(batches).toEqual([
      { events: [], dropped: 1_000_000 },
      { events: [], dropped: 500_000 },
    ]);
    expect(await outboxFor(dir).dropped()).toBe(0);
  });

  it('afterFetch sends nothing while a back-off timer is pending, until it fires', async () => {
    let fail = true;
    const { clock, batches, reporter } = setup(() =>
      fail ? Promise.reject(new WirebenchError('server-unreachable', 'down')) : Promise.resolve(),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(clock.pending).toEqual([5000]);
    fail = false;
    await reporter.afterFetch();
    expect(batches).toHaveLength(1);
    expect(clock.pending).toEqual([5000]);
    await clock.fireNext();
    expect(batches).toHaveLength(2);
    expect(await files()).toEqual([]);
  });

  it('afterFetch sends at once when no timer is pending', async () => {
    const { clock, batches, reporter } = setup();
    await outboxFor(dir).append(ev(1), 'u1');
    await reporter.afterFetch();
    expect(batches).toHaveLength(1);
    expect(clock.pending).toEqual([]);
  });

  it('a 429 with a retry-after longer than the back-off schedules that long', async () => {
    const { clock, reporter } = setup(() =>
      Promise.reject(
        new WirebenchError('audit-desktop-rate-limited', 'slow', { details: { status: 429, retryAfterMs: 60_000 } }),
      ),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(clock.pending).toEqual([60_000]);
  });

  it('caps a retry-after of 900 s at 300 s', async () => {
    const { clock, reporter } = setup(() =>
      Promise.reject(
        new WirebenchError('audit-desktop-rate-limited', 'slow', { details: { status: 429, retryAfterMs: 900_000 } }),
      ),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(clock.pending).toEqual([300_000]);
  });

  it('signed out keeps the files and waits for onSignedIn', async () => {
    let token = undefined as string | undefined;
    const { clock, batches, reporter } = setup(undefined, () => token);
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(await files()).toHaveLength(1);
    expect(clock.pending).toEqual([]);
    await reporter.enqueue(ev(2), 'w1');
    expect(clock.pending).toEqual([]);
    token = 'tok';
    await reporter.onSignedIn();
    expect(batches.map((b) => b.events.length)).toEqual([2]);
    expect(await files()).toEqual([]);
  });

  it('ignores enqueue for a non-recording or missing target', async () => {
    const { clock, reporter } = setup();
    reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: false });
    await reporter.enqueue(ev(1), 'w1');
    reporter.setTarget(undefined);
    await reporter.enqueue(ev(2), 'w1');
    expect(await files()).toEqual([]);
    expect(clock.pending).toEqual([]);
  });

  it('reports the dropped count once, with the first batch', async () => {
    const { batches, reporter } = setup();
    const o = new AuditOutbox(dir, { max: 2 });
    for (let n = 0; n < 5; n++) await o.append(ev(n), 'u1');
    await reporter.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.dropped).toBe(3);
    await reporter.enqueue(ev(9), 'w1');
    await reporter.flush();
    expect(batches[1]!.dropped).toBeUndefined();
  });

  it('never runs two flushes at once and follows up an enqueue made during one', async () => {
    let release: () => void = () => undefined;
    let active = 0;
    let maxActive = 0;
    const { batches, reporter } = setup(async () => {
      active++;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((r) => (release = r));
      active--;
    });
    await reporter.enqueue(ev(1), 'w1');
    const first = reporter.flush();
    await until(() => active === 1);
    await reporter.enqueue(ev(2), 'w1');
    const second = reporter.flush();
    const releaseFirst = release;
    releaseFirst();
    await until(() => active === 1 && release !== releaseFirst);
    release();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect(batches.flatMap((b) => b.events)).toHaveLength(2);
    expect(await files()).toEqual([]);
  });

  it('never throws into its caller', async () => {
    const { reporter } = setup(() => Promise.reject(new Error('boom')));
    await reporter.enqueue(ev(1), 'w1');
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.dispose();
  });

  it('a 400 drops that batch, counts it, and sends the count with the next batch', async () => {
    let n = 0;
    const { batches, reporter } = setup(() => {
      n++;
      return n === 1
        ? Promise.reject(new WirebenchError('server-bad-request', 'bad', { details: { status: 400 } }))
        : Promise.resolve();
    });
    for (let i = 0; i < 3; i++) await reporter.enqueue(ev(i), 'w1');
    await reporter.flush();
    expect(batches).toHaveLength(2);
    expect(batches[1]!.events).toEqual([]);
    expect(batches[1]!.dropped).toBe(3);
    expect(await files()).toEqual([]);
    expect(await new AuditOutbox(dir).dropped()).toBe(0);
  });

  it.each([403, 404])('a %i clears the outbox and stops until the next setTarget', async (status) => {
    const { clock, batches, reporter } = setup(() =>
      Promise.reject(new WirebenchError('server-forbidden', 'no', { details: { status } })),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(await files()).toEqual([]);
    expect(clock.pending).toEqual([]);
    await reporter.enqueue(ev(2), 'w1');
    expect(await files()).toEqual([]);
    expect(batches).toHaveLength(1);
  });

  it('a 409 for the old target after setTarget(B) does not switch B off', async () => {
    const dirB = await mkdtemp(join(tmpdir(), 'wb-reporter-b-'));
    try {
      let release: (() => void) | undefined;
      const { reporter } = setup(
        () =>
          new Promise<void>((_ok, fail) => {
            release = () => fail(new WirebenchError('audit-desktop-recording-off', 'off'));
          }),
      );
      await reporter.enqueue(ev(1), 'w1');
      const flushing = reporter.flush();
      await until(() => release !== undefined);
      reporter.setTarget({ url: 'https://s.example', workspaceId: 'w2', dir: dirB, recording: true });
      release?.();
      await flushing;
      await reporter.enqueue(ev(2), 'w2');
      expect(await readdir(dirB)).toHaveLength(1);
    } finally {
      await rm(dirB, { recursive: true, force: true });
    }
  });

  it('keeps every event when setTarget is called again on the same directory while appending', async () => {
    const { reporter } = setup();
    const target = { url: 'https://s.example', workspaceId: 'w1', dir, recording: true } as const;
    const pending: Promise<void>[] = [];
    for (let i = 0; i < 20; i++) {
      pending.push(reporter.enqueue(ev(i), 'w1'));
      reporter.setTarget(target);
    }
    await Promise.all(pending);
    expect(await files()).toHaveLength(20);
  });

  it('schedules a flush for an enqueue whose append resolves after the last drain check', async () => {
    // One microtask puts the append's resolution after drainLoop's last check and before `running` clears.
    const TICKS = 1;
    const { clock, batches, reporter } = setup();
    const outbox = outboxFor(dir);
    await reporter.enqueue(ev(1), 'w1');
    // Hold the late enqueue's append open, and release it just as the final drain pass finds nothing.
    let openGate: () => void = () => undefined;
    const gate = new Promise<void>((r) => (openGate = r));
    outbox.append = async () => gate;
    const realDropped = outbox.dropped.bind(outbox);
    const realAppend = AuditOutbox.prototype.append.bind(outbox);
    let calls = 0;
    outbox.dropped = async () => {
      const n = await realDropped();
      if (++calls === 2) {
        await realAppend(ev(2), 'u1');
        void (async () => {
          for (let i = 0; i < TICKS; i++) await Promise.resolve();
          openGate();
        })();
      }
      return n;
    };
    const flushing = reporter.flush();
    const late = reporter.enqueue(ev(2), 'w1');
    await Promise.all([flushing, late]);
    expect(clock.pending).toEqual([2000]);
    await clock.fireNext();
    expect(batches.flatMap((b) => b.events)).toEqual([ev(1), ev(2)]);
    expect(await files()).toEqual([]);
  });

  it('a refused dropped-only batch subtracts only the count it carried', async () => {
    let calls = 0;
    const { batches, reporter } = setup(async () => {
      calls++;
      if (calls === 1) {
        // Two more events are dropped while this request is in flight.
        await outboxFor(dir).addDropped(2);
        throw new WirebenchError('server-bad-request', 'bad', { details: { status: 400 } });
      }
    });
    await outboxFor(dir).addDropped(3);
    await reporter.flush();
    expect(batches).toHaveLength(2);
    expect(batches[0]).toEqual({ events: [], dropped: 3 });
    expect(batches[1]).toEqual({ events: [], dropped: 2 });
    expect(await outboxFor(dir).dropped()).toBe(0);
  });

  it("never sends one account's queued events as another: they are dropped and counted", async () => {
    let accounts = [account('u1')];
    let token: string | undefined = 'tok';
    const { batches, reporter } = setup(
      undefined,
      () => token,
      () => accounts,
    );
    // Signed out: the queue keeps u1's events, stamped with the last account known.
    accounts = [account('u1', true)];
    token = undefined;
    await reporter.enqueue(ev(1), 'w1');
    await reporter.enqueue(ev(2), 'w1');
    await reporter.flush();
    expect(batches).toHaveLength(0);
    expect(await files()).toHaveLength(2);
    // Someone else signs in to the same server.
    accounts = [account('u2')];
    token = 'tok2';
    await reporter.onSignedIn();
    expect(batches).toEqual([{ events: [], dropped: 2 }]);
    expect(await files()).toEqual([]);
    // u2's own events go out as theirs.
    await reporter.enqueue(ev(3), 'w1');
    await reporter.flush();
    expect(batches[1]).toEqual({ events: [ev(3)] });
  });

  it('sends the signed-in account its own events and drops the others in the same batch', async () => {
    const { batches, reporter } = setup();
    await outboxFor(dir).append(ev(1), 'u1');
    await outboxFor(dir).append(ev(2), 'u2');
    await outboxFor(dir).append(ev(3), 'u1');
    await reporter.flush();
    expect(batches).toEqual([{ events: [ev(1), ev(3)], dropped: 1 }]);
  });

  it('counts an event as dropped when no account was ever known for the server', async () => {
    const { reporter } = setup(undefined, undefined, () => []);
    await reporter.enqueue(ev(1), 'w1');
    expect(await files()).toEqual([]);
    expect(await outboxFor(dir).dropped()).toBe(1);
  });

  it('re-picks the batch when the account changes while its token is read', async () => {
    let accounts = [account('u1')];
    let reads = 0;
    const { batches, reporter } = setup(
      undefined,
      () => {
        // Someone else signs in between the batch being picked and the token being read.
        if (++reads === 1) accounts = [account('u2')];
        return 'tok';
      },
      () => accounts,
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    expect(batches).toEqual([{ events: [], dropped: 1 }]);
  });

  it('refuses an event for a workspace other than the current target', async () => {
    const { clock, reporter } = setup();
    await reporter.enqueue(ev(1), 'w-closed');
    await reporter.enqueue(ev(2), undefined);
    expect(await files()).toEqual([]);
    expect(clock.pending).toEqual([]);
    expect(reporter.workspaceId).toBe('w1');
  });

  it('an unchanged target keeps its back-off', async () => {
    const { clock, reporter } = setup(() => Promise.reject(new WirebenchError('server-unreachable', 'down')));
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    await clock.fireNext();
    expect(clock.pending).toEqual([10000]);
    reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: true });
    expect(clock.pending).toEqual([10000]);
    await reporter.afterFetch();
    expect(clock.pending).toEqual([10000]);
  });

  it('an unchanged target fetched as recording again after a 409 resumes', async () => {
    let off = true;
    const { clock, batches, reporter } = setup(() =>
      off ? Promise.reject(new WirebenchError('audit-desktop-recording-off', 'off')) : Promise.resolve(),
    );
    await reporter.enqueue(ev(1), 'w1');
    await reporter.flush();
    await reporter.enqueue(ev(2), 'w1');
    expect(await files()).toEqual([]);
    off = false;
    reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: true });
    await reporter.enqueue(ev(3), 'w1');
    await reporter.afterFetch();
    await clock.fireNext();
    expect(batches.at(-1)).toEqual({ events: [ev(3)] });
    expect(await files()).toEqual([]);
  });
});
