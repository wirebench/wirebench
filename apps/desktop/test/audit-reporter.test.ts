import { mkdtemp, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { WirebenchError } from '@wirebench/engine';
import type { DesktopAuditBatch, DesktopAuditEvent } from '@wirebench/engine';
import { AuditOutbox } from '../src/main/audit/outbox.js';
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
  }
}
const settle = async (): Promise<void> => {
  for (let i = 0; i < 60; i++) await new Promise((r) => setImmediate(r));
};

let dir: string;
beforeEach(async () => {
  dir = await mkdtemp(join(tmpdir(), 'wb-reporter-'));
});
afterEach(async () => {
  await rm(dir, { recursive: true, force: true });
});

function setup(
  send: (b: DesktopAuditBatch) => Promise<void> = () => Promise.resolve(),
  tokenOf: () => string | undefined = () => 'tok',
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
    accounts: { tokenFor: () => Promise.resolve(tokenOf()), markSignedOut: () => undefined },
    now: () => new Date(clock.time),
    setTimeout: clock.setTimeout,
    clearTimeout: clock.clearTimeout,
  });
  reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: true });
  return { clock, batches, reporter };
}
const files = async (): Promise<string[]> => (await readdir(dir)).filter((f) => f !== 'dropped.json');

describe('AuditReporter', () => {
  it('flushes about 2 s after an event is queued', async () => {
    const { clock, batches, reporter } = setup();
    await reporter.enqueue(ev(1));
    expect(clock.pending).toEqual([2000]);
    expect(batches).toHaveLength(0);
    await clock.fireNext();
    expect(batches).toHaveLength(1);
    expect(await files()).toEqual([]);
  });

  it('sends 250 events as 100, 100, 50 oldest first', async () => {
    const { batches, reporter } = setup();
    for (let n = 0; n < 250; n++) await reporter.enqueue(ev(n));
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
    await reporter.enqueue(ev(1));
    await reporter.enqueue(ev(2));
    await reporter.flush();
    expect(await files()).toEqual([]);
    await reporter.enqueue(ev(3));
    expect(await files()).toEqual([]);
    off = false;
    reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: true });
    await reporter.enqueue(ev(4));
    expect(await files()).toHaveLength(1);
    expect(batches).toHaveLength(1);
  });

  it('backs off 5 s doubling to 300 s on a network failure, then retries', async () => {
    let fail = true;
    const { clock, batches, reporter } = setup(() =>
      fail ? Promise.reject(new WirebenchError('server-unreachable', 'down')) : Promise.resolve(),
    );
    await reporter.enqueue(ev(1));
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

  it('signed out keeps the files and waits for onSignedIn', async () => {
    let token = undefined as string | undefined;
    const { clock, batches, reporter } = setup(undefined, () => token);
    await reporter.enqueue(ev(1));
    await reporter.flush();
    expect(await files()).toHaveLength(1);
    expect(clock.pending).toEqual([]);
    await reporter.enqueue(ev(2));
    expect(clock.pending).toEqual([]);
    token = 'tok';
    await reporter.onSignedIn();
    expect(batches.map((b) => b.events.length)).toEqual([2]);
    expect(await files()).toEqual([]);
  });

  it('ignores enqueue for a non-recording or missing target', async () => {
    const { clock, reporter } = setup();
    reporter.setTarget({ url: 'https://s.example', workspaceId: 'w1', dir, recording: false });
    await reporter.enqueue(ev(1));
    reporter.setTarget(undefined);
    await reporter.enqueue(ev(2));
    expect(await files()).toEqual([]);
    expect(clock.pending).toEqual([]);
  });

  it('reports the dropped count once, with the first batch', async () => {
    const { batches, reporter } = setup();
    const o = new AuditOutbox(dir, { max: 2 });
    for (let n = 0; n < 5; n++) await o.append(ev(n));
    await reporter.flush();
    expect(batches).toHaveLength(1);
    expect(batches[0]!.dropped).toBe(3);
    await reporter.enqueue(ev(9));
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
    await reporter.enqueue(ev(1));
    const first = reporter.flush();
    await settle();
    await reporter.enqueue(ev(2));
    const second = reporter.flush();
    release();
    await settle();
    release();
    await Promise.all([first, second]);
    expect(maxActive).toBe(1);
    expect(batches.flatMap((b) => b.events)).toHaveLength(2);
    expect(await files()).toEqual([]);
  });

  it('never throws into its caller', async () => {
    const { reporter } = setup(() => Promise.reject(new Error('boom')));
    await reporter.enqueue(ev(1));
    await expect(reporter.flush()).resolves.toBeUndefined();
    reporter.dispose();
  });
});
