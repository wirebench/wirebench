/**
 * Slice 5 Task 5 (hosted edition spec §20.3): the tenant map and the data-key cache of two hosted servers on one
 * schema stay in step through the notification bus. A tenant created through one resolves on the other; a data key
 * written on one is what the other's cache hands out next; a bus that is lost and listens again drops both caches;
 * and the resolver's poll, now only a backstop, is 10 min.
 */
import { randomUUID } from 'node:crypto';
import Fastify from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { openSession, type Session } from '../../../src/db/pool.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { environmentKeyRoot, newDataKey } from '../../../src/tenancy/keys.js';
import { RELOAD_MS, type TenantResolver } from '../../../src/tenancy/resolve.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { manualTimers } from '../../helpers/timers.js';

const log = Fastify({ logger: false }).log;
const APP_DOMAIN = 'example.test';
const ROOT = Buffer.alloc(32, 7);
const ENV = { WIREBENCH_SERVER_SECRETS_KEY: ROOT.toString('base64') };
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });

interface Node {
  readonly h: IdentityHarness;
  readonly resolver: TenantResolver;
  readonly registry: InstanceRegistry;
  readonly bus: NotificationBus;
  /** The bus's listening sessions, newest last. */
  readonly sessions: Session[];
}

describeDb('the tenant map and the data-key cache on the bus (hosted spec §20.3)', () => {
  let db: TestDatabase;
  let dataDir: string;
  const nodes: Node[] = [];

  beforeEach(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir();
  });
  afterEach(async () => {
    for (const node of nodes.splice(0)) {
      await node.h.close();
      await node.bus.stop(0);
      await node.registry.stop();
    }
    await db.close();
    await removeTempDir(dataDir);
  });

  /** One hosted server with its own instance row, bus and tenant map. */
  const node = async (): Promise<Node> => {
    const timers = manualTimers();
    const holder = randomUUID();
    const registry = new InstanceRegistry({
      db,
      holder,
      mode: 'multi',
      url: 'http://127.0.0.1:1',
      version: '0.0.0-test',
      setTimer: timers.setTimer,
      log: () => undefined,
    });
    await registry.start();
    const signals = new BusSignals();
    let resolver: TenantResolver | undefined;
    const h = await identityHarness({
      db,
      dataDir,
      env: ENV,
      configure: hosted,
      instance: registry,
      bus: signals,
      onTenantResolver: (r) => {
        resolver = r;
      },
    });
    const sessions: Session[] = [];
    const bus = new NotificationBus({
      db,
      holder,
      hooks: h.hooks,
      open: async () => {
        const session = await openSession(db.url, { applicationName: 'wirebench-test-bus' });
        sessions.push(session);
        return session;
      },
      scopeFor: async (tenantId) => (await directoryOf(h.ctx.tenancy).get(tenantId))?.scope,
      log,
      retryDelayMs: 50,
      maxRetryDelayMs: 200,
    });
    signals.attach(bus);
    await bus.start();
    const made: Node = { h, resolver: resolver!, registry, bus, sessions };
    nodes.push(made);
    return made;
  };

  it('a tenant created through one resolves on the other within 2 s', async () => {
    const a = await node();
    const b = await node();
    expect(b.resolver.resolve('acme.example.test')).toBeUndefined();
    const created = await new TenantAdmin(db, directoryOf(a.h.ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
    await vi.waitFor(
      () => {
        expect(b.resolver.resolve('acme.example.test')?.tenantId).toBe(created.scope.tenantId);
      },
      { timeout: 2_000, interval: 20 },
    );
  });

  it('a data key written on one is what the other hands out next', async () => {
    const a = await node();
    const b = await node();
    const { scope } = await new TenantAdmin(db, directoryOf(a.h.ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
    const first = await b.h.ctx.tenancy.dataKey(scope);
    // The row loses its key (a cleared column), and A makes a new one by its compare-and-set.
    await db.query('update tenants set data_key = null where id = $1::uuid', [scope.tenantId]);
    const second = await a.h.ctx.tenancy.dataKey(scope);
    expect(second.equals(first)).toBe(false);
    await vi.waitFor(
      async () => {
        expect((await b.h.ctx.tenancy.dataKey(scope)).equals(second)).toBe(true);
      },
      { timeout: 2_000, interval: 20 },
    );
  });

  it('a lost bus drops both caches when it listens again', async () => {
    await node();
    const b = await node();
    const { scope } = await new TenantAdmin(db, directoryOf(b.h.ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
    const first = await b.h.ctx.tenancy.dataKey(scope);
    // Writes no process announces, as while B's bus was down: a tenant and a re-sealed key.
    const quiet = randomUUID();
    await db.query(`insert into tenants (id, slug, name) values ($1::uuid, 'quiet', 'Quiet')`, [quiet]);
    const replaced = newDataKey();
    await db.query('update tenants set data_key = $1 where id = $2::uuid', [
      await environmentKeyRoot(ROOT).wrap(scope.tenantId, replaced),
      scope.tenantId,
    ]);
    expect(b.resolver.resolve('quiet.example.test')).toBeUndefined();
    expect((await b.h.ctx.tenancy.dataKey(scope)).equals(first)).toBe(true);
    await db.query('select pg_terminate_backend($1)', [b.sessions[0]!.pid]);
    await vi.waitFor(
      async () => {
        expect(b.sessions).toHaveLength(2);
        expect(b.resolver.resolve('quiet.example.test')?.tenantId).toBe(quiet);
        expect((await b.h.ctx.tenancy.dataKey(scope)).equals(replaced)).toBe(true);
      },
      { timeout: 5_000, interval: 20 },
    );
  });

  it('keeps the key it just wrote, and reloads its own map once per write (review M2)', async () => {
    const a = await node();
    const b = await node();
    const { scope } = await new TenantAdmin(db, directoryOf(a.h.ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
    const reloads = vi.spyOn(a.resolver, 'invalidate');
    const remoteReloads = vi.spyOn(b.resolver, 'invalidate');
    await new TenantAdmin(db, directoryOf(a.h.ctx.tenancy)).create({ slug: 'beta', name: 'Beta' });
    await vi.waitFor(() => {
      expect(remoteReloads).toHaveBeenCalledTimes(1);
    });
    expect(reloads).toHaveBeenCalledTimes(1);
    const made = await a.h.ctx.tenancy.dataKey(scope);
    // Re-sealed behind A's back: a cache that dropped its own fresh key would read this one.
    await db.query('update tenants set data_key = $1 where id = $2::uuid', [
      await environmentKeyRoot(ROOT).wrap(scope.tenantId, newDataKey()),
      scope.tenantId,
    ]);
    await new Promise((done) => setTimeout(done, 250));
    expect((await a.h.ctx.tenancy.dataKey(scope)).equals(made)).toBe(true);
  });

  it('polls the directory every 10 min, a backstop behind the bus', () => {
    expect(RELOAD_MS).toBe(600_000);
  });
});
