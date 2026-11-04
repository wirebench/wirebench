/**
 * Suspension across instances (hosted edition spec §22.7; slice 7 Task 10): a tenant suspended through the lifecycle
 * on one hosted server closes its live sockets `4403 tenant-suspended` on another, through the notification bus, those
 * still waiting for `auth` included, and tells both servers' other stopped-tenant listeners (the host instances, the
 * terminal shares). Another tenant's sockets stay open. The stop runs on each successful read of the tenant map (review
 * I1), so a read that failed, or a bus that was down, closes them on the next one; a socket that upgraded on a stale
 * map is refused at `auth`. The host instances' and the shares' own work is covered where they are
 * (`host/lease.test.ts`, `terminal-shares/registry.test.ts`); the second suite reaches both through the lifecycle.
 */
import { randomUUID } from 'node:crypto';
import Fastify, { type FastifyInstance } from 'fastify';
import { randomBytes } from 'node:crypto';
import { LIVE_PATH, TERMINAL_SHARE_CLOSE, TERMINAL_SHARE_PATH } from '@wirebench/engine';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import type { ServerModule } from '../../../src/context.js';
import { openControlDb, type ControlDb } from '../../../src/control-plane/control-db.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { openSession, type Session } from '../../../src/db/pool.js';
import { HOST_CLOSE } from '../../../src/host/errors.js';
import type { HostInstances } from '../../../src/host/instances.js';
import { hostModule } from '../../../src/host/module.js';
import { sessionCookieName } from '../../../src/identity/cookies.js';
import { newId } from '../../../src/identity/tokens.js';
import { licensingModule } from '../../../src/licensing/module.js';
import { liveModule } from '../../../src/live/module.js';
import { teamsModule } from '../../../src/teams/module.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { terminalSharesModule } from '../../../src/terminal-shares/module.js';
import { BusSignals, NotificationBus } from '../../../src/operations/bus.js';
import { InstanceRegistry } from '../../../src/operations/instances.js';
import { TENANT_STOPPED_CLOSE, type TenantResolver } from '../../../src/tenancy/resolve.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import type { TenantScope } from '../../../src/tenancy/scope.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { browserBuildFixture, type BrowserBuildFixture } from '../../helpers/browser-build.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { testKeys } from '../../helpers/licensing.js';
import { markStepsDone } from '../../helpers/tenancy.js';
import { manualTimers } from '../../helpers/timers.js';
import {
  openSocket,
  setEdition,
  twoTenants,
  type Tenant,
  type TestSocket,
  type TwoTenants,
} from '../tenancy/modules/two-tenants.js';

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
  /** The bus's listening connections, newest last; while `down`, a new one cannot be opened. */
  readonly link: { down: boolean; readonly sessions: Session[] };
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
    const link: Node['link'] = { down: false, sessions: [] };
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
      open: async () => {
        if (link.down) throw new Error('the bus is down');
        const session = await openSession(db.url, { applicationName: 'wirebench-test-bus' });
        link.sessions.push(session);
        return session;
      },
      scopeFor: async (tenantId) => (await directoryOf(h.ctx.tenancy).get(tenantId))?.scope,
      log,
      retryDelayMs: 50,
      maxRetryDelayMs: 200,
    });
    signals.attach(bus);
    await bus.start();
    const stopped: ReadonlySet<string>[] = [];
    h.ctx.tenancy.onTenantsStopped((ids) => stopped.push(ids));
    const made: Node = { h, api: api!, resolver: resolver!, registry, bus, stopped, link };
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

  /** Two servers with acme and beta on both maps; the lifecycle writes on A. */
  const twoNodes = async () => {
    const a = await node();
    const b = await node();
    const lifecycle = new TenantLifecycle({ control, tenancy: a.h.ctx.tenancy, hooks: a.h.hooks });
    const acme = await lifecycle.create({ slug: 'acme', name: 'Acme', edition: 'team', editionSource: 'operator' });
    await vi.waitFor(
      () => {
        expect(b.resolver.resolve('acme.example.test')).toBeDefined();
      },
      { timeout: 5_000, interval: 20 },
    );
    return { a, b, lifecycle, acme };
  };

  it('a reload that fails leaves B a stale map: a socket authenticating there is refused 4403, and the poll’s reload closes one waiting for auth (review I1)', async () => {
    const { b, lifecycle, acme } = await twoNodes();
    const who = await signedInUser(b.h, { email: `${randomUUID()}@acme.test`, tdb: b.h.ctx.tenancy.db(acme.scope) });
    // B's reads of the map fail from here: the suspension's reload keeps the map it had.
    const hosted = vi.spyOn(directoryOf(b.h.ctx.tenancy), 'hosted').mockRejectedValue(new Error('db blip'));
    await lifecycle.suspend('acme');
    await vi.waitFor(() => {
      expect(hosted).toHaveBeenCalled();
    });
    expect(b.resolver.resolve('acme.example.test')).toBeDefined();
    // Upgraded on the stale map, then refused at `auth` by a fresh read of the tenant's status.
    const authenticating = await live(b, acme.scope, false);
    authenticating.send({ type: 'auth', token: who.token });
    expect(await authenticating.closed).toBe(TENANT_STOPPED_CLOSE);
    // Upgraded on the stale map and waiting for `auth`: the next successful read, the poll's, closes it.
    const waiting = await live(b, acme.scope, false);
    hosted.mockRestore();
    await b.resolver.invalidate();
    expect(await waiting.closed).toBe(TENANT_STOPPED_CLOSE);
    expect(b.resolver.resolve('acme.example.test')).toBeUndefined();
  });

  it('suspending while B’s bus is down closes B’s sockets once it listens again (review I2)', async () => {
    const { b, lifecycle, acme } = await twoNodes();
    const signedIn = await live(b, acme.scope);
    let closedEarly = false;
    void signedIn.closed.then(() => (closedEarly = true));
    // B's listening connection drops, and cannot be opened again until `down` clears.
    b.link.down = true;
    await db.query('select pg_terminate_backend($1)', [b.link.sessions.at(-1)!.pid]);
    await lifecycle.suspend('acme');
    // B heard nothing: its map is the old one, and its socket is still open.
    await new Promise((done) => setTimeout(done, 300));
    expect(b.resolver.resolve('acme.example.test')).toBeDefined();
    expect(closedEarly).toBe(false);
    b.link.down = false;
    expect(await signedIn.closed).toBe(TENANT_STOPPED_CLOSE);
    expect(b.stopped.some((ids) => ids.has(acme.scope.tenantId))).toBe(true);
  });
});

/**
 * The host instances and the terminal shares on one hosted server, stopped through the lifecycle's own write (review
 * I2): `lifecycle.suspend` changes the directory, the resolver reloads, and the stopped-tenant listeners the host and
 * terminal-share modules subscribed close their sockets. Beta, active, keeps its own.
 */
describeDb('a suspension’s hosts and shares (hosted spec §22.7)', () => {
  let t: TwoTenants;
  let build: BrowserBuildFixture;
  let control: ControlDb;
  let lifecycle: TenantLifecycle;
  let instances: HostInstances | undefined;
  const timers = manualTimers();
  const hostTimers = manualTimers();
  const keys = testKeys();
  const users: Partial<Record<'acme' | 'beta', { owner: SignedInUser; viewer: SignedInUser }>> = {};
  const workspace = newId();
  const sockets: TestSocket[] = [];

  beforeAll(async () => {
    build = await browserBuildFixture();
    t = await twoTenants({
      env: {
        WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
        WIREBENCH_SERVER_SECRETS_KEY: randomBytes(32).toString('base64'),
      },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        teamsModule({ now: () => clock.now }),
        liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
        terminalSharesModule({ now: () => clock.now, setTimer: timers.setTimer }),
        hostModule({
          now: () => clock.now,
          setTimer: hostTimers.setTimer,
          browserRoot: build.root,
          onInstances: (made) => {
            instances = made;
          },
        }),
      ],
    });
    await markStepsDone(t.h.db.owner);
    await ensureControlRole(t.h.db.owner, t.h.db.controlUrl, t.h.db.url);
    control = openControlDb(t.h.db.controlUrl);
    lifecycle = new TenantLifecycle({ control, tenancy: t.h.ctx.tenancy, hooks: t.h.hooks });
    for (const tenant of [t.a, t.b]) {
      await setEdition(t, tenant, 'enterprise');
      const owner = await tenant.user({ email: 'owner@example.com', kind: 'browser' });
      const viewer = await tenant.user({ email: 'viewer@example.com' });
      const team = await teamsRepo.insertTeam(tenant.tdb, { id: newId(), name: 'Ops', at: t.h.clock.now });
      for (const user of [owner, viewer]) {
        await teamsRepo.insertMember(tenant.tdb, {
          teamId: team.id,
          userId: user.user.id,
          role: 'member',
          at: t.h.clock.now,
        });
      }
      await teamsRepo.insertWorkspace(tenant.tdb, {
        id: workspace,
        name: `Prod ${tenant.slug}`,
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: t.h.clock.now,
      });
      users[tenant.slug] = { owner, viewer };
    }
  });
  afterEach(async () => {
    // Each case suspends acme; the next one starts with it serving again.
    await lifecycle.resume('acme');
    await expect.poll(async () => (await t.a.inject({ method: 'GET', url: '/api/v1/meta' })).statusCode).toBe(200);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await Promise.all(sockets.map((socket) => socket.closed));
    await control.close();
    let closed = false;
    const closing = t.close().then(() => {
      closed = true;
    });
    await vi.waitFor(
      () => {
        timers.fire(2_000);
        expect(closed).toBe(true);
      },
      { timeout: 10_000, interval: 50 },
    );
    await closing;
    await build.remove();
  });

  const host = async (tenant: Tenant): Promise<TestSocket> => {
    const socket = await openSocket(t, tenant, '/api/v1/host', {
      origin: tenant.origin,
      cookie: `${sessionCookieName(tenant.origin)}=${users[tenant.slug]!.owner.token}`,
    });
    sockets.push(socket);
    await socket.next('hello');
    return socket;
  };
  const shareSocket = async (tenant: Tenant, who: 'owner' | 'viewer', shareId: string): Promise<TestSocket> => {
    const socket = await openSocket(t, tenant, TERMINAL_SHARE_PATH);
    sockets.push(socket);
    socket.send({ type: 'auth', token: users[tenant.slug]![who].token, workspaceId: workspace, shareId });
    await socket.next(who === 'owner' ? 'ready' : 'viewer-ready');
    return socket;
  };
  const share = async (tenant: Tenant): Promise<string> => {
    const res = await tenant.call<{ shareId: string }>(
      users[tenant.slug]!.owner,
      'POST',
      `/workspaces/${workspace}/terminal-shares`,
      { hostName: 'web', cols: 80, rows: 24 },
    );
    expect(res.status).toBe(201);
    return res.body.shareId;
  };

  it('closes the tenant’s host sockets 4403 tenant-suspended and evicts its host, through lifecycle.suspend', async () => {
    const inA = await host(t.a);
    const inB = await host(t.b);
    let bClosed = false;
    void inB.closed.then(() => (bClosed = true));
    expect(instances?.size).toBe(2);

    await lifecycle.suspend('acme');

    expect(await inA.closed).toBe(HOST_CLOSE.forbidden);
    await vi.waitFor(() => {
      expect(instances?.size).toBe(1);
    });
    expect(bClosed).toBe(false);
  });

  it('ends the tenant’s terminal shares, owner and viewer closing 4403, through lifecycle.suspend', async () => {
    const acmeShare = await share(t.a);
    const owner = await shareSocket(t.a, 'owner', acmeShare);
    const viewer = await shareSocket(t.a, 'viewer', acmeShare);
    const betaShare = await share(t.b);
    const kept = await shareSocket(t.b, 'owner', betaShare);
    let keptClosed = false;
    void kept.closed.then(() => (keptClosed = true));

    await lifecycle.suspend('acme');

    expect(await owner.closed).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    expect(await viewer.closed).toBe(TERMINAL_SHARE_CLOSE.forbidden);
    expect(keptClosed).toBe(false);
  });
});
