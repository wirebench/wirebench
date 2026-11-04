/**
 * Slice 5 Task 2 (hosted edition spec §20.1, §20.10): which licenses let a self-hosted server run several instances,
 * the hourly check of a running one, and the table `admin instances` prints.
 */
import { describe, expect, it, vi } from 'vitest';
import { formatAge, formatInstances } from '../../../src/operations/cli.js';
import {
  allowsMultipleInstances,
  HEARTBEAT_MS,
  InstanceRegistry,
  LICENSE_CHECK_MS,
  licenseLapseWatch,
} from '../../../src/operations/instances.js';
import { manualTimers } from '../../helpers/timers.js';

describe('the heartbeat and stop (review M3)', () => {
  /** A pool whose upserts wait until the test lets them go; every statement is recorded in order. */
  const pool = () => {
    const statements: string[] = [];
    const held: (() => void)[] = [];
    const db = {
      query: (text: string) => {
        statements.push(text.trim().split(/\s+/)[0]!);
        if (!text.startsWith('insert')) return Promise.resolve({ rows: [] });
        return new Promise<{ rows: never[] }>((done) => held.push(() => done({ rows: [] })));
      },
    };
    return { db, statements, release: () => held.splice(0).forEach((go) => go()) };
  };

  it('skips a beat while one renew runs, and stop waits for it before deleting the row', async () => {
    const { db, statements, release } = pool();
    const timers = manualTimers();
    const registry = new InstanceRegistry({
      db,
      holder: '11111111-1111-4111-8111-111111111111',
      mode: 'multi',
      version: '0.0.0-test',
      setTimer: timers.setTimer,
      log: () => undefined,
    });
    const starting = registry.start();
    release();
    await starting;
    statements.length = 0;
    timers.fire(HEARTBEAT_MS); // a renew starts and hangs on its upsert
    timers.fire(HEARTBEAT_MS); // the next beat finds it running and skips
    await Promise.resolve();
    expect(statements).toEqual(['insert']);
    let stopped = false;
    const stopping = registry.stop().then(() => {
      stopped = true;
    });
    await new Promise((done) => setTimeout(done, 10));
    // The delete waits: a renew landing after it would bring the stopped row back.
    expect(statements).toEqual(['insert']);
    expect(stopped).toBe(false);
    release();
    await stopping;
    expect(statements).toEqual(['insert', 'delete', 'delete']);
    expect(statements.at(-1)).toBe('delete');
  });
});

describe('the license several instances need (ruling 3)', () => {
  it('is Enterprise, valid or in grace', () => {
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'active' })).toBe(true);
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'grace' })).toBe(true);
  });
  it('is not Community, Team, or an Enterprise license expired or invalid, nor one that could not be read', () => {
    expect(allowsMultipleInstances({ edition: 'community', status: 'none' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'team', status: 'active' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'team', status: 'grace' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'expired' })).toBe(false);
    expect(allowsMultipleInstances({ edition: 'enterprise', status: 'invalid' })).toBe(false);
    expect(allowsMultipleInstances(undefined)).toBe(false);
  });
});

describe('a lapse while running (spec §20.1)', () => {
  const watch = (states: (Parameters<typeof allowsMultipleInstances>[0] | Error)[]) => {
    const clock = { now: 0 };
    const warn = vi.fn();
    const read = vi.fn(() => {
      const next = states.shift();
      return next instanceof Error ? Promise.reject(next) : Promise.resolve(next);
    });
    const beat = licenseLapseWatch({ read, warn, now: () => clock.now });
    return { clock, warn, read, beat };
  };

  it('reads nothing until an hour has passed since the last check', async () => {
    const { clock, read, beat } = watch([{ edition: 'enterprise', status: 'active' }]);
    clock.now = LICENSE_CHECK_MS - 1;
    await beat();
    expect(read).not.toHaveBeenCalled();
    clock.now = LICENSE_CHECK_MS;
    await beat();
    expect(read).toHaveBeenCalledTimes(1);
  });

  it('warns once an hour while lapsed, and only warns: nothing stops', async () => {
    const { clock, warn, beat } = watch([
      { edition: 'enterprise', status: 'grace' },
      { edition: 'enterprise', status: 'expired' },
      { edition: 'enterprise', status: 'expired' },
    ]);
    clock.now = LICENSE_CHECK_MS;
    await beat();
    expect(warn).not.toHaveBeenCalled();
    clock.now = 2 * LICENSE_CHECK_MS;
    await beat();
    // Beats in between the hours read and warn nothing more.
    clock.now = 2 * LICENSE_CHECK_MS + 15_000;
    await beat();
    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn.mock.calls[0]![0]).toMatch(
      /keeps running, and the next start refuses with server-instances-need-enterprise/,
    );
    expect(warn.mock.calls[0]![1]).toEqual({ edition: 'enterprise', status: 'expired' });
    clock.now = 3 * LICENSE_CHECK_MS;
    await beat();
    expect(warn).toHaveBeenCalledTimes(2);
  });

  it('warns when the license cannot be read, and does not throw', async () => {
    const { clock, warn, beat } = watch([new Error('database down')]);
    clock.now = LICENSE_CHECK_MS;
    await expect(beat()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(expect.any(String), { edition: null, status: null });
  });
});

describe('admin instances output (spec §20.10)', () => {
  it('formats ages at a glance', () => {
    expect(formatAge(5)).toBe('5s');
    expect(formatAge(125)).toBe('2m 5s');
    expect(formatAge(3 * 3600 + 120)).toBe('3h 2m');
    expect(formatAge(4 * 86_400 + 3600)).toBe('4d 1h');
  });

  it('prints a header and one line per instance: holder, address, version, age, last renew', () => {
    const text = formatInstances([
      {
        holder: '11111111-1111-4111-8111-111111111111',
        url: 'http://10.0.0.5:8091',
        version: '6.2.0',
        startedAt: '2026-11-03T10:00:00Z',
        renewedAt: '2026-11-03T10:05:00Z',
        ageSeconds: 305,
        renewedSecondsAgo: 5,
      },
      {
        holder: '22222222-2222-4222-8222-222222222222',
        url: null,
        version: '6.2.0',
        startedAt: '2026-11-03T10:01:00Z',
        renewedAt: '2026-11-03T10:05:02Z',
        ageSeconds: 242,
        renewedSecondsAgo: 3,
      },
    ]);
    const lines = text.split('\n');
    expect(lines[0]).toMatch(/^HOLDER\s+ADDRESS\s+VERSION\s+AGE\s+LAST RENEW$/);
    expect(lines[1]).toMatch(
      /^11111111-1111-4111-8111-111111111111 {2}http:\/\/10\.0\.0\.5:8091 {2}6\.2\.0 {4}5m 5s {2}2026-11-03T10:05:00Z \(5s ago\)$/,
    );
    expect(lines[2]).toContain('22222222-2222-4222-8222-222222222222  -  ');
    expect(lines).toHaveLength(3);
  });
});

describe('readiness and draining (spec §20.5, §20.9)', () => {
  /** A bus's signals the test fires by hand. */
  const signals = () => {
    const listened: ((listened: { reconnected: boolean }) => void)[] = [];
    const lost: ((error: Error) => void)[] = [];
    return {
      events: {
        onListen: (listener: (listened: { reconnected: boolean }) => void) => listened.push(listener),
        onLost: (listener: (error: Error) => void) => lost.push(listener),
      },
      listen: (reconnected: boolean) => listened.forEach((one) => one({ reconnected })),
      lose: () => lost.forEach((one) => one(new Error('connection terminated'))),
    };
  };
  const made = (log: (message: string, error: unknown) => void = () => undefined) =>
    new InstanceRegistry({
      db: { query: () => Promise.resolve({ rows: [] }) },
      holder: '22222222-2222-4222-8222-222222222222',
      mode: 'multi',
      version: '0.0.0-test',
      setTimer: manualTimers().setTimer,
      log,
    });

  it('is starting until start-up finished, ready while the bus listens, reconnecting while it is lost', () => {
    const registry = made();
    const bus = signals();
    registry.watchBus(bus.events);
    expect(registry.readiness()).toBe('starting');
    bus.listen(false);
    // Listening, but start-up has not finished.
    expect(registry.readiness()).toBe('starting');
    registry.serving();
    expect(registry.readiness()).toBe('ready');
    bus.lose();
    expect(registry.readiness()).toBe('reconnecting');
    bus.listen(true);
    expect(registry.readiness()).toBe('ready');
  });

  it('is not ready once served if the bus never listened', () => {
    const registry = made();
    registry.watchBus(signals().events);
    registry.serving();
    expect(registry.readiness()).toBe('reconnecting');
  });

  it('drains once: draining from the first call, every listener run side by side and waited for, a failure logged', async () => {
    const logged: string[] = [];
    const registry = made((message) => logged.push(message));
    const bus = signals();
    registry.watchBus(bus.events);
    bus.listen(false);
    registry.serving();
    const order: string[] = [];
    let release: () => void = () => undefined;
    const held = new Promise<void>((done) => {
      release = done;
    });
    registry.onDrain(async () => {
      order.push('host started');
      await held;
      order.push('host done');
    });
    registry.onDrain(() => {
      order.push('live');
      return Promise.reject(new Error('boom'));
    });
    expect(registry.draining).toBe(false);
    let drained = false;
    const draining = registry.drain().then(() => {
      drained = true;
    });
    expect(registry.draining).toBe(true);
    expect(registry.readiness()).toBe('draining');
    // A bus that listens again does not make a draining process ready.
    bus.listen(true);
    expect(registry.readiness()).toBe('draining');
    await new Promise((done) => setTimeout(done, 5));
    expect(order).toEqual(['host started', 'live']);
    expect(drained).toBe(false);
    // A second call is the same drain: no listener runs twice.
    const again = registry.drain();
    release();
    await Promise.all([draining, again]);
    expect(order).toEqual(['host started', 'live', 'host done']);
    expect(logged).toEqual(['a drain listener failed']);
  });
});
