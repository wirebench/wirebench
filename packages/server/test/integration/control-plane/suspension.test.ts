/**
 * Suspension across instances (hosted edition spec §22.7; slice 7 Task 10): a tenant suspended through the lifecycle
 * on one hosted server closes its live sockets `4403 tenant-suspended` on another, through the notification bus, those
 * still waiting for `auth` included, and tells both servers' other stopped-tenant listeners (the host instances, the
 * terminal shares). Another tenant's sockets stay open. The host instances' and the shares' own work is covered where
 * they are (`host/lease.test.ts`, `terminal-shares/registry.test.ts`).
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { LIVE_PATH } from '@wirebench/engine';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import type { ServerModule } from '../../../src/context.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { openSession } from '../../../src/db/pool.js';
import { liveModule } from '../../../src/live/module.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import { TENANT_STOPPED_CLOSE, type TenantResolver } from '../../../src/tenancy/resolve.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';
import { manualTimers } from '../../helpers/timers.js';
import { openSocket, type Tenant, type TestSocket, type TwoTenants } from '../tenancy/modules/two-tenants.js';

const log = Fastify({ logger: false }).log;
const APP_DOMAIN = 'example.test';
const ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });

interface Node {
  readonly h: IdentityHarness;
  readonly api: FastifyInstance;
  readonly resolver: TenantResolver;
  readonly registry: InstanceRegistry;
  readonly bus: NotificationBus;
  /** Every set of stopped tenants this server's listeners were told. */
  readonly stopped: ReadonlySet<string>[];
}

describeDb('suspension across instances (hosted spec §22.7)', () => {
  let db: TestDatabase;
  let dataDir: string;
  let control: ControlDb;
  const nodes: Node[] = [];
  const sockets: TestSocket[] = [];

  beforeEach(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir();
    await ensureControlRole(db.owner, db.controlUrl, db.url);
    control = openControlDb(db.controlUrl);
  });
  afterEach(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const node of nodes.splice(0)) {
      await node.h.close();
      await node.bus.stop(0);
      await node.registry.stop();
    }
    await control.close();
    await db.close();
    await removeTempDir(dataDir);
  });

  /** One hosted server with the live module, its own instance row, bus and tenant map. */
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
    let api: FastifyInstance | undefined;
    const probe: ServerModule = {
      name: 'agent',
      // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async
      register: async (app) => {
        api = app;
      },
    };
    const h = await identityHarness({
      db,
      dataDir,
      env: ENV,
      configure: hosted,
      instance: registry,
      bus: signals,
      modules: (clock) => [liveModule({ now: () => clock.now }), probe],
      onTenantResolver: (r) => {
        resolver = r;
      },
    });
    const bus = new NotificationBus({
      db,
      holder,
      hooks: h.hooks,
      open: () => openSession(db.url, { applicationName: 'wirebench-test-bus' }),
      scopeFor: async (tenantId) => (await directoryOf(h.ctx.tenancy).get(tenantId))?.scope,
      log,
      retryDelayMs: 50,
      maxRetryDelayMs: 200,
    });
    signals.attach(bus);
    await bus.start();
    const stopped: ReadonlySet<string>[] = [];
    h.ctx.tenancy.onTenantsStopped((ids) => stopped.push(ids));
    const made: Node = { h, api: api!, resolver: resolver!, registry, bus, stopped };
    nodes.push(made);
    return made;
  };

  /** A live socket on `on`'s host of `scope`, signed in as a new user of that tenant unless `auth` is false. */
  const live = async (on: Node, scope: TenantScope, auth = true): Promise<TestSocket> => {
    const tenant = { host: `${scope.slug}.${APP_DOMAIN}` } as Tenant;
    const socket = await openSocket({ api: on.api } as TwoTenants, tenant, LIVE_PATH);
    sockets.push(socket);
    if (auth) {
      const who = await signedInUser(on.h, {
        email: `${randomUUID()}@${scope.slug}.test`,
        tdb: on.h.ctx.tenancy.db(scope),
      });
      socket.send({ type: 'auth', token: who.token });
      await socket.next('ready');
    }
    return socket;
  };

  it('suspending on one closes the tenant’s live sockets on the other 4403, and leaves another tenant’s open', async () => {
    const a = await node();
    const b = await node();
    const lifecycle = new TenantLifecycle({ control, tenancy: a.h.ctx.tenancy, hooks: a.h.hooks });
    const acme = await lifecycle.create({ slug: 'acme', name: 'Acme', edition: 'team', editionSource: 'operator' });
    const beta = await lifecycle.create({ slug: 'beta', name: 'Beta', edition: 'team', editionSource: 'operator' });
    await vi.waitFor(
      () => {
        expect(b.resolver.resolve('beta.example.test')).toBeDefined();
        expect(b.resolver.resolve('acme.example.test')).toBeDefined();
      },
      { timeout: 5_000, interval: 20 },
    );
    const signedIn = await live(b, acme.scope);
    const waiting = await live(b, acme.scope, false);
    const other = await live(b, beta.scope);
    let otherClosed = false;
    void other.closed.then(() => (otherClosed = true));

    await lifecycle.suspend('acme');

    expect(await signedIn.closed).toBe(TENANT_STOPPED_CLOSE);
    expect(await waiting.closed).toBe(TENANT_STOPPED_CLOSE);
    // Both servers' listeners heard it: A from its own write, B through the bus.
    for (const one of [a, b]) {
      await vi.waitFor(() => {
        expect(one.stopped.some((ids) => ids.has(acme.scope.tenantId))).toBe(true);
      });
      expect(one.stopped.some((ids) => ids.has(beta.scope.tenantId))).toBe(false);
    }
    // The other tenant's socket is still served.
    other.send({ type: 'subscribe', workspaceId: '01JB3Z9K7Q4ZJ6X1V8W2M5N0WS' });
    await other.next('refused');
    expect(otherClosed).toBe(false);
    // And B's map answers the suspended host why.
    await vi.waitFor(async () => {
      const res = await b.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: 'acme.example.test' } });
      expect(res.statusCode).toBe(403);
    });
  });
});
