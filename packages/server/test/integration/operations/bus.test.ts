/**
 * Slice 5 Task 3 (hosted edition spec §20.3): the notification bus, two buses on one database. An event reaches the
 * other process's `cluster` listeners and not its `local` ones; a process ignores its own notification; an oversized
 * event becomes `resync`; a full queue drops the oldest; a killed listening connection reconnects and listens again;
 * two schemas never hear each other.
 */
import { randomUUID } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import {
  announce,
  cluster,
  local,
  serverHooks,
  type AccessChangedEvent,
  type HeadMovedEvent,
  type PresenceChangedEvent,
  type ServerHooks,
} from '../../../src/context.js';
import { openSession, type Session } from '../../../src/db/pool.js';
import { NotificationBus, QUEUE_LIMIT, type BusQuerier, type Listened } from '../../../src/operations/bus.js';
import { scopeOf, type TenantScope } from '../../../src/tenancy/scope.js';
import { startServer } from '../../../src/serve.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

const TENANT = scopeOf({ id: randomUUID(), slug: 'acme' });
const log = Fastify({ logger: false }).log;

const head = (n: number): HeadMovedEvent => ({
  tenantId: TENANT.tenantId,
  workspaceId: '01J8ZC5Q0V7R3T9XK2M4N6P8QA',
  head: String(n).padStart(40, '0'),
  tokenId: '01J8ZC5Q0V7R3T9XK2M4N6P8QB',
});

interface Process {
  readonly holder: string;
  readonly hooks: ServerHooks;
  readonly bus: NotificationBus;
  /** The listening sessions opened, newest last. */
  readonly sessions: Session[];
  /** What each list heard, by kind of listener. */
  readonly heard: { cluster: unknown[]; local: unknown[] };
  /** Every listen and resync its bus ran its `onListen` listeners for. */
  readonly listened: Listened[];
}

describeDb('the notification bus (hosted spec §20.3)', () => {
  let db: TestDatabase;
  const started: NotificationBus[] = [];
  const others: TestDatabase[] = [];
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(async () => {
    for (const bus of started.splice(0)) await bus.stop(0);
    for (const other of others.splice(0)) await other.close();
    await db.close();
  });

  const process = (
    on: TestDatabase = db,
    options: { queueLimit?: number; scopes?: readonly TenantScope[]; start?: boolean; pool?: BusQuerier } = {},
  ): Process => {
    const holder = randomUUID();
    const hooks = serverHooks();
    const sessions: Session[] = [];
    const heard = { cluster: [] as unknown[], local: [] as unknown[] };
    hooks.headMoved.push(
      cluster((event) => heard.cluster.push(event)),
      local((event) => heard.local.push(event)),
    );
    const bus = new NotificationBus({
      db: options.pool ?? on,
      holder,
      hooks,
      open: async () => {
        const session = await openSession(on.url, { applicationName: 'wirebench-test-bus' });
        sessions.push(session);
        return session;
      },
      scopeFor: (tenantId) =>
        Promise.resolve((options.scopes ?? [TENANT]).find((scope) => scope.tenantId === tenantId)),
      log,
      retryDelayMs: 50,
      maxRetryDelayMs: 200,
      sendRetryDelaysMs: [10, 20],
      ...(options.queueLimit !== undefined ? { queueLimit: options.queueLimit } : {}),
    });
    const listened: Listened[] = [];
    bus.onListen((event) => listened.push(event));
    started.push(bus);
    return { holder, hooks, bus, sessions, heard, listened };
  };

  /** `on`, whose `pg_notify` throws the next `failures` times. */
  const flaky = (on: TestDatabase, failures: number): BusQuerier & { failures: number } => {
    const pool = {
      failures,
      query: (text: string, params?: readonly unknown[]) => {
        if (pool.failures > 0) {
          pool.failures--;
          return Promise.reject(new Error('the pool is down'));
        }
        return on.query(text, params);
      },
    };
    return pool;
  };

  /** Lets notifications in flight arrive: a round trip on each bus's pool and a moment more. */
  const settle = () => new Promise((done) => setTimeout(done, 250));

  it("reaches the other process's cluster listener and not its local one, and is not heard twice here", async () => {
    const a = process();
    const b = process();
    await a.bus.start();
    await b.bus.start();
    expect(a.bus.channel).toMatch(/^wirebench_bus_[0-9a-f]+$/);
    expect(b.bus.channel).toBe(a.bus.channel);
    announce(a.hooks.headMoved, head(1), log);
    // Here at once, by both kinds.
    expect(a.heard).toEqual({ cluster: [head(1)], local: [head(1)] });
    await vi.waitFor(() => {
      expect(b.heard.cluster).toEqual([head(1)]);
    });
    await settle();
    // There, by the cluster listener only; here, A's own notification came back and was dropped.
    expect(b.heard.local).toEqual([]);
    expect(a.heard).toEqual({ cluster: [head(1)], local: [head(1)] });
  });

  it('keeps one process’s order, and rebuilds the scope from tenantId, dropping an unknown tenant', async () => {
    const a = process();
    const b = process();
    const access: AccessChangedEvent[] = [];
    b.hooks.accessChanged.push(cluster((event) => access.push(event)));
    await a.bus.start();
    await b.bus.start();
    for (let n = 0; n < 20; n++) announce(a.hooks.headMoved, head(n), log);
    const stranger = scopeOf({ id: randomUUID(), slug: 'stranger' });
    announce(a.hooks.accessChanged, { tenantId: stranger.tenantId, tenant: stranger, userId: 'u1' }, log);
    announce(a.hooks.accessChanged, { tenantId: TENANT.tenantId, tenant: TENANT, workspaceId: 'w1' }, log);
    await vi.waitFor(() => {
      expect(access).toHaveLength(1);
    });
    expect(b.heard.cluster).toEqual(Array.from({ length: 20 }, (_, n) => head(n)));
    expect(access[0]).toEqual({ tenantId: TENANT.tenantId, tenant: TENANT, workspaceId: 'w1' });
    expect(access[0]!.tenant).toBe(TENANT);
  });

  it('splits a big room’s presence into parts under the limit, never a resync (review M1)', async () => {
    const a = process();
    const b = process();
    const presence: PresenceChangedEvent[] = [];
    const resyncs: unknown[] = [];
    b.hooks.presenceChanged.push(cluster((event) => presence.push(event)));
    b.hooks.resync.push(cluster((event) => resyncs.push(event)));
    await a.bus.start();
    await b.bus.start();
    const users = Array.from({ length: 600 }, (_, n) => `01J8ZD${String(n).padStart(20, '0')}`);
    const event = { tenantId: TENANT.tenantId, workspaceId: 'w1', holder: a.holder, users };
    announce(a.hooks.presenceChanged, event, log);
    announce(a.hooks.presenceChanged, { ...event, users: users.slice(0, 2) }, log);
    await vi.waitFor(() => {
      expect(presence.at(-1)?.users).toEqual(users.slice(0, 2));
    });
    const parts = presence.slice(0, -1);
    expect(parts.length).toBeGreaterThan(1);
    expect(parts.map((part) => [part.part, part.parts])).toEqual(parts.map((_, n) => [n, parts.length]));
    expect(new Set(parts.map((part) => part.seq)).size).toBe(1);
    expect(parts.flatMap((part) => part.users)).toEqual(users);
    // The small one after is whole: no parts, so it applies as it is.
    expect(presence.at(-1)?.parts).toBeUndefined();
    expect(resyncs).toEqual([]);
  });

  it('retries a failed send with a short backoff, so a blip loses nothing (review I2)', async () => {
    const pool = flaky(db, 2);
    const a = process(db, { pool });
    const b = process();
    await a.bus.start();
    await b.bus.start();
    announce(a.hooks.headMoved, head(1), log);
    await vi.waitFor(() => {
      expect(b.heard.cluster).toEqual([head(1)]);
    });
    expect(a.bus.stats()).toMatchObject({ failed: 0 });
    await settle();
    expect(b.listened).toEqual([{ reconnected: false }]);
  });

  it('gives a send up after three tries, then sends the missed marker and the peers resync (review I2)', async () => {
    const pool = flaky(db, 0);
    const a = process(db, { pool });
    const b = process();
    const resyncs: unknown[] = [];
    b.hooks.resync.push(cluster((event) => resyncs.push(event)));
    await a.bus.start();
    await b.bus.start();
    pool.failures = 3;
    announce(a.hooks.headMoved, head(1), log);
    // The queue is idle after the give-up, and the marker can go at once.
    await vi.waitFor(() => {
      expect(b.listened).toEqual([{ reconnected: false }, { reconnected: true }]);
    });
    expect(b.heard.cluster).toEqual([]);
    expect(resyncs).toEqual([]); // the tenant-less marker is a resync of everything, not a tenant's
    expect(a.bus.stats()).toMatchObject({ failed: 1 });
    expect(a.listened).toEqual([{ reconnected: false }]);
  });

  it('sends the marker once a send succeeds again when the marker itself failed (review I2)', async () => {
    const pool = flaky(db, 0);
    const a = process(db, { pool });
    const b = process();
    await a.bus.start();
    await b.bus.start();
    pool.failures = 6; // the event's three tries and the marker's
    announce(a.hooks.headMoved, head(1), log);
    await vi.waitFor(() => {
      expect(pool.failures).toBe(0);
    });
    await settle();
    expect(b.listened).toEqual([{ reconnected: false }]);
    announce(a.hooks.headMoved, head(2), log);
    await vi.waitFor(() => {
      expect(b.heard.cluster).toEqual([head(2)]);
      expect(b.listened).toEqual([{ reconnected: false }, { reconnected: true }]);
    });
  });

  it('drops the oldest from a full queue, counts it, and sends the rest in order', async () => {
    expect(QUEUE_LIMIT).toBe(10_000);
    const a = process(db, { queueLimit: 3 });
    const b = process();
    await b.bus.start();
    // Not listening yet: nothing drains, so the queue fills.
    for (let n = 0; n < 5; n++) a.bus.send('headMoved', head(n));
    expect(a.bus.stats()).toMatchObject({ queued: 3, dropped: 2, failed: 0 });
    await a.bus.start();
    await vi.waitFor(() => {
      expect(b.heard.cluster).toEqual([head(2), head(3), head(4)]);
      // Review I2: what was dropped is announced as missed, and the peer resyncs.
      expect(b.listened).toEqual([{ reconnected: false }, { reconnected: true }]);
    });
    expect(a.bus.stats()).toMatchObject({ queued: 0, dropped: 2, failed: 0 });
  });

  it('reconnects a killed listening connection, calls onLost and onListen, and hears again', async () => {
    const a = process();
    const b = process();
    const listened = b.listened;
    const lost: Error[] = [];
    b.bus.onLost((error) => lost.push(error));
    await a.bus.start();
    await b.bus.start();
    expect(listened).toEqual([{ reconnected: false }]);
    await db.query('select pg_terminate_backend($1)', [b.sessions[0]!.pid]);
    await vi.waitFor(() => {
      expect(listened).toEqual([{ reconnected: false }, { reconnected: true }]);
    });
    expect(lost).toHaveLength(1);
    expect(b.sessions).toHaveLength(2);
    announce(a.hooks.headMoved, head(7), log);
    await vi.waitFor(() => {
      expect(b.heard.cluster).toEqual([head(7)]);
    });
  });

  it('flushes what is queued when it stops, and carries nothing after', async () => {
    const a = process();
    const b = process();
    await a.bus.start();
    await b.bus.start();
    announce(a.hooks.headMoved, head(1), log);
    await a.bus.stop();
    announce(a.hooks.headMoved, head(2), log);
    await vi.waitFor(() => {
      expect(b.heard.cluster).toEqual([head(1)]);
    });
    await settle();
    expect(b.heard.cluster).toEqual([head(1)]);
  });

  it('never lets two schemas on one database hear each other', async () => {
    const other = await testDatabase();
    others.push(other);
    const a = process(db);
    const b = process(other);
    const c = process(db);
    await a.bus.start();
    await b.bus.start();
    await c.bus.start();
    expect(b.bus.channel).not.toBe(a.bus.channel);
    announce(a.hooks.headMoved, head(1), log);
    announce(b.hooks.headMoved, head(2), log);
    await vi.waitFor(() => {
      expect(c.heard.cluster).toEqual([head(1)]);
    });
    await settle();
    expect(b.heard.cluster).toEqual([head(2)]); // its own, delivered locally
    expect(c.heard.cluster).toEqual([head(1)]);
  });

  it("starts with the server, on the running lock's URL, carries its announcements, and stops with it", async () => {
    const dataDir = await mkTempDir();
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
    };
    const modules = BUILTIN_MODULES.map((m) => ({
      name: m.name,
      ...(m.migrationsDir !== undefined ? { migrationsDir: m.migrationsDir } : {}),
      register: () => Promise.resolve(),
    }));
    const listener = process();
    await listener.bus.start();
    const server = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        modules,
        logStream: new Writable({ write: (_chunk, _encoding, done) => done() }),
      },
    );
    const busSessions = () =>
      db.query<{ user: string }>(
        `select usename::text as user from pg_stat_activity where application_name = 'wirebench-server-bus'`,
      );
    try {
      expect(server.bus.channel).toBe(listener.bus.channel);
      // The migration URL is the owner's here: the bus listens where the running lock is held.
      expect((await busSessions()).rows).toEqual([{ user: 'wirebench_owner' }]);
      announce(server.ctx.hooks.headMoved, head(3), log);
      await vi.waitFor(() => {
        expect(listener.heard.cluster).toEqual([head(3)]);
      });
    } finally {
      await server.close();
      await removeTempDir(dataDir);
    }
    expect((await busSessions()).rows).toEqual([]);
  });
});
