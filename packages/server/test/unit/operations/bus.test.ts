/**
 * Slice 5 Part A review (hosted edition spec §20.3): the bus over a fake pool and a fake listening connection. A stop
 * flushes every drain, not only the first (M4); a remote event with a scope looks its tenant up only when a cluster
 * listener wants it, and once per tenant until the directory changes (M5); a full inbox drops the oldest and resyncs
 * this process as a lost bus would (M5).
 */
import { randomUUID } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';
import { describe, expect, it, vi } from 'vitest';
import { cluster, serverHooks, type AccessChangedEvent } from '../../../src/context.js';
import { encode } from '../../../src/operations/bus-codec.js';
import { NotificationBus, type BusConnection, type Listened } from '../../../src/operations/bus.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';

const quiet = (): void => undefined;
const log = { warn: quiet, info: quiet, debug: quiet, error: quiet, child: () => log } as unknown as FastifyBaseLogger;
const TENANT = scopeOf({ id: randomUUID(), slug: 'acme' });
const PEER = randomUUID();
const CHANNEL = 'wirebench_bus_1a';
const WS = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';

const head = (n: number) => ({
  tenantId: TENANT.tenantId,
  workspaceId: WS,
  head: String(n).padStart(40, '0'),
  tokenId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
});

function fake(
  options: {
    query?: (payload: string) => Promise<unknown>;
    scopeFor?: (tenantId: string) => Promise<TenantScope | undefined>;
    inboxLimit?: number;
    lag?: (ms: number) => void;
  } = {},
) {
  const sent: string[] = [];
  let heard: ((channel: string, payload: string) => void) | undefined;
  const connection: BusConnection = {
    query: <R extends Record<string, unknown>>(text: string) =>
      Promise.resolve({ rows: (text.startsWith('select') ? [{ channel: CHANNEL }] : []) as unknown as R[] }),
    onLost: quiet,
    onNotification: (listener) => {
      heard = listener;
    },
    close: () => Promise.resolve(),
  };
  const hooks = serverHooks();
  const scopeFor = vi.fn(options.scopeFor ?? (() => Promise.resolve(TENANT)));
  const bus = new NotificationBus({
    db: {
      query: async (_text, params) => {
        const payload = params![1] as string;
        await (options.query?.(payload) ?? Promise.resolve());
        sent.push(payload);
      },
    },
    holder: randomUUID(),
    hooks,
    open: () => Promise.resolve(connection),
    scopeFor,
    log,
    sendRetryDelaysMs: [1, 1],
    ...(options.inboxLimit !== undefined ? { inboxLimit: options.inboxLimit } : {}),
    ...(options.lag !== undefined ? { lag: options.lag } : {}),
  });
  const listened: Listened[] = [];
  bus.onListen((event) => listened.push(event));
  /** A notification from the peer. */
  const from = (kind: Parameters<typeof encode>[1], event: object, at?: number): void => {
    for (const payload of encode(PEER, kind, event, 0, at) ?? []) heard?.(CHANNEL, payload);
  };
  /** A payload as it came off the wire, the process's own included. */
  const raw = (payload: string): void => heard?.(CHANNEL, payload);
  return { bus, hooks, sent, scopeFor, listened, from, raw };
}

describe('the bus’s stop (review M4)', () => {
  it('waits for every drain within the deadline, not only the first', async () => {
    // A send that lands after a drain's last check and before it ends starts a second drain. Where that window falls
    // is a matter of microtasks, so the sends come at each offset in turn.
    for (let ticks = 0; ticks < 12; ticks++) {
      let release: (() => void) | undefined;
      const f = fake({
        query: (payload) =>
          payload.includes('0001"')
            ? new Promise<void>((done) => (release = done))
            : new Promise<void>((done) => setTimeout(done, 5)),
      });
      await f.bus.start();
      f.bus.send('headMoved', head(1));
      await vi.waitFor(() => {
        expect(release).toBeDefined();
      });
      release!();
      for (let n = 0; n < ticks; n++) await Promise.resolve();
      f.bus.send('headMoved', head(2));
      f.bus.send('headMoved', head(3));
      await f.bus.stop(2_000);
      const heads = f.sent.map((payload) => (JSON.parse(payload) as { head: string }).head.slice(-1));
      expect(heads, `after ${String(ticks)} ticks`).toEqual(['1', '2', '3']);
    }
  });
});

describe('the bus’s inbox (review M5)', () => {
  const access = (userId: string): AccessChangedEvent => ({ tenantId: TENANT.tenantId, tenant: TENANT, userId });

  it('looks no scope up for a kind no cluster listener hears', async () => {
    const f = fake();
    await f.bus.start();
    f.from('accessChanged', access('u1'));
    f.from('licenseChanged', { tenantId: TENANT.tenantId, action: 'removed', actorUserId: null });
    await new Promise((done) => setTimeout(done, 10));
    expect(f.scopeFor).not.toHaveBeenCalled();
  });

  it('looks a tenant’s scope up once, and again only after the directory changed', async () => {
    const f = fake();
    const heard: AccessChangedEvent[] = [];
    f.hooks.accessChanged.push(cluster((event) => heard.push(event)));
    await f.bus.start();
    f.from('accessChanged', access('u1'));
    f.from('accessChanged', access('u2'));
    await vi.waitFor(() => {
      expect(heard).toHaveLength(2);
    });
    expect(f.scopeFor).toHaveBeenCalledTimes(1);
    expect(heard[1]!.tenant).toBe(TENANT);
    f.from('tenantsChanged', {});
    f.from('accessChanged', access('u3'));
    await vi.waitFor(() => {
      expect(heard).toHaveLength(3);
    });
    expect(f.scopeFor).toHaveBeenCalledTimes(2);
  });

  it('drops the oldest from a full inbox, then resyncs this process as a lost bus would', async () => {
    let release: (() => void) | undefined;
    const slow = new Promise<TenantScope>((done) => (release = () => done(TENANT)));
    const f = fake({ scopeFor: () => slow, inboxLimit: 3 });
    const heard: AccessChangedEvent[] = [];
    f.hooks.accessChanged.push(cluster((event) => heard.push(event)));
    await f.bus.start();
    // The first waits on the lookup; of the five behind it, the two oldest go.
    for (let n = 0; n < 6; n++) f.from('accessChanged', access(`u${String(n)}`));
    expect(f.bus.stats()).toMatchObject({ inboxDropped: 2 });
    release!();
    await vi.waitFor(() => {
      expect(f.listened).toEqual([{ reconnected: false }, { reconnected: true }]);
    });
    expect(heard.map((event) => event.userId)).toEqual(['u0', 'u3', 'u4', 'u5']);
  });

  it('treats a peer’s tenant-less resync as its own lost bus (review I2)', async () => {
    const f = fake();
    const resyncs: unknown[] = [];
    f.hooks.resync.push(cluster((event) => resyncs.push(event)));
    await f.bus.start();
    f.from('resync', {});
    await vi.waitFor(() => {
      expect(f.listened).toEqual([{ reconnected: false }, { reconnected: true }]);
    });
    f.from('resync', { tenantId: TENANT.tenantId });
    await vi.waitFor(() => {
      expect(resyncs).toEqual([{ tenantId: TENANT.tenantId }]);
    });
    expect(f.listened).toHaveLength(2);
  });
});

describe('the bus’s lag (spec §20.8)', () => {
  it('tells each peer notification’s age from its send time, and never its own or one not understood', async () => {
    const lags: number[] = [];
    const f = fake({ lag: (ms) => lags.push(ms) });
    await f.bus.start();
    f.from('headMoved', head(1), Date.now() - 250);
    expect(lags).toHaveLength(1);
    expect(lags[0]).toBeGreaterThanOrEqual(250);
    expect(lags[0]).toBeLessThan(5_000);
    // Its own echo, and a payload out of shape, are dropped before anything is measured.
    f.bus.send('headMoved', head(2));
    await vi.waitFor(() => {
      expect(f.sent).toHaveLength(1);
    });
    f.raw(f.sent[0]!);
    f.raw('not json');
    expect(lags).toHaveLength(1);
    await f.bus.stop(0);
  });

  it('hears a peer on the previous version, which sends no send time, and records no lag for it', async () => {
    const lags: number[] = [];
    const heard: unknown[] = [];
    const f = fake({ lag: (ms) => lags.push(ms) });
    f.hooks.headMoved.push(cluster((event) => heard.push(event)));
    await f.bus.start();
    const old = JSON.parse(encode(PEER, 'headMoved', head(3))![0]!) as Record<string, unknown>;
    delete old.at;
    f.raw(JSON.stringify(old));
    await vi.waitFor(() => {
      expect(heard).toEqual([head(3)]);
    });
    expect(lags).toEqual([]);
    await f.bus.stop(0);
  });
});
