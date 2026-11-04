/**
 * Slice 5 Task 14 (hosted edition spec §20.11, §11's criterion): two full servers, started through `startServer` as
 * `serve` starts one, on one schema and one data directory. Each has its own holder, instance row, internal relay
 * port and notification bus; both run `multi` on a self-hosted configuration with an Enterprise license. The cases
 * that stop a server start a third one beside the pair, so the pair lives for the whole file.
 *
 * The lower-level suites prove each mechanism on its own (`hub-bus`, `tenancy-bus`, `repo-lock`, `share-relay`,
 * `budgets`, `host/lease`); these cases only show that the real start-up wires them together across two processes.
 * Hosted mode is refused by `loadConfig` until the control plane lands, so the tenant case reads the new tenant
 * through the other server's directory and bus, not through the hosted resolver, which `tenancy-bus` covers.
 */
import { randomBytes } from 'node:crypto';
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { LIVE_CLOSE, type LiveServerMessage, type SyncPushResponse } from '@wirebench/engine';
import { announce, cluster, remote, type AccessChangedEvent, type ServerModule } from '../../../src/context.js';
import { HOST_CLOSE } from '../../../src/host/errors.js';
import type { HostInstances } from '../../../src/host/instances.js';
import { hostModule } from '../../../src/host/module.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { SendBudgets, type SendTake } from '../../../src/operations/budgets.js';
import { REPO_LOCK_CLASS } from '../../../src/operations/repo-lock.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { browserBuildFixture, type BrowserBuildFixture } from '../../helpers/browser-build.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { openHost, PUBLIC_URL, type HostTestClient } from '../../helpers/host.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { openLive, type LiveTestClient } from '../../helpers/live.js';
import { freePort } from '../../helpers/net.js';
import { seedSyncWorkspace } from '../../helpers/sync.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';
import { openShare, sharingLicenseService, type ShareClient } from '../../helpers/terminal-shares.js';

const SECRETS_KEY = randomBytes(32).toString('base64');
/** Six sends a minute is a burst of one (spec §20.7): the second send of the tenant, on either server, is refused. */
const SENDS_PER_MINUTE = 6;
const CONCURRENT_SENDS = 16;
const WAIT_MS = 5_000;
const AT = '2026-11-04T12:00:00.000Z';

type Message<T extends LiveServerMessage['type']> = Extract<LiveServerMessage, { type: T }>;

interface Instance {
  readonly server: RunningServer;
  /** The server seen as the helpers' harness: its app, context, default tenant and repositories, on the real clock. */
  readonly h: IdentityHarness;
  readonly port: number;
  hosts(): HostInstances;
}

describeDb('two instances on one database and one data directory (hosted spec §20.11)', () => {
  let db: TestDatabase;
  let dataDir: string;
  let build: BrowserBuildFixture;
  let a: Instance;
  let b: Instance;
  const started: Instance[] = [];
  const sockets: { close(): void }[] = [];
  let users = 0;

  /** The production module list, with the browser client's stand-in build and an Enterprise license with sharing. */
  const modules = (onInstances: (made: HostInstances) => void): readonly ServerModule[] =>
    BUILTIN_MODULES.map((m): ServerModule => {
      if (m.name === 'host') return hostModule({ browserRoot: build.root, onInstances });
      if (m.name !== 'licensing') return m;
      const license = sharingLicenseService();
      return {
        ...m,
        register: async (app, ctx) => {
          await m.register(app, ctx);
          ctx.license = license;
        },
      };
    });

  /** One server as `serve` starts it, `multi` with its own public and internal ports. */
  const instance = async (): Promise<Instance> => {
    const port = await freePort();
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_PUBLIC_URL: PUBLIC_URL,
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(port),
      WIREBENCH_SERVER_INSTANCES: 'multi',
      WIREBENCH_SERVER_INSTANCE_URL: `http://127.0.0.1:${String(await freePort())}`,
      WIREBENCH_SERVER_SECRETS_KEY: SECRETS_KEY,
      WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
      WIREBENCH_SERVER_TENANT_SENDS_PER_MINUTE: String(SENDS_PER_MINUTE),
    };
    let hosts: HostInstances | undefined;
    const server = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      {
        signals: new EventEmitter(),
        exit: vi.fn(),
        modules: modules((made) => {
          hosts = made;
        }),
        logStream: new Writable({ write: (_chunk, _encoding, done) => done() }),
      },
    );
    const h = {
      app: server.app,
      ctx: server.ctx,
      hooks: server.ctx.hooks,
      repos: server.ctx.repos,
      db,
      dataDir,
      tdb: server.ctx.tenancy.db(directoryOf(server.ctx.tenancy).defaultScope()),
      clock: {
        get now() {
          return new Date();
        },
      },
    } as unknown as IdentityHarness;
    const made: Instance = {
      server,
      h,
      port,
      hosts: () => {
        if (hosts === undefined) throw new Error('the host module did not register');
        return hosts;
      },
    };
    started.push(made);
    return made;
  };

  beforeAll(async () => {
    db = await testDatabase();
    dataDir = await mkTempDir();
    build = await browserBuildFixture();
    // One after the other: the first migrates the schema, the second finds it migrated.
    a = await instance();
    b = await instance();
    expect(a.server.ctx.instance.holder).not.toBe(b.server.ctx.instance.holder);
    expect(a.server.ctx.instance.mode).toBe('multi');
    expect(b.server.bus.channel).toBe(a.server.bus.channel);
  }, 120_000);

  afterAll(async () => {
    for (const socket of sockets.splice(0)) socket.close();
    for (const one of started.splice(0)) await one.server.close();
    await build?.remove();
    await db?.close();
    if (dataDir !== undefined) await removeTempDir(dataDir);
  }, 60_000);

  /** A user of the default tenant with a device token; a unique address per call. */
  const user = (name: string, extra: { readonly serverAdmin?: boolean } = {}): Promise<SignedInUser> =>
    signedInUser(a.h, { email: `${name}${String(++users)}@example.com`, ...extra });

  /** A browser session for `who`, as the cookie sign-in leaves one: what the host socket takes. */
  const browserSession = async (who: SignedInUser): Promise<SignedInUser> => {
    const { token, hash } = mintToken();
    const tokenId = newId();
    await identityRepo.insertToken(a.h.tdb, {
      id: tokenId,
      userId: who.user.id,
      tokenHash: hash,
      deviceName: 'browser',
      kind: 'browser',
      at: new Date(),
    });
    return { user: who.user, token, tokenId, headers: { authorization: `Bearer ${token}` } };
  };

  /** A team with `admin` and `members`, and one repository-backed workspace. */
  const workspace = async (admin: SignedInUser, members: readonly SignedInUser[] = []): Promise<string> => {
    const team = await seedTeam(a.h, { name: `Team ${String(users)}`, admins: [admin], members });
    return seedSyncWorkspace(a.h, { team, name: 'Staging' });
  };

  const live = async (on: Instance, who: SignedInUser, workspaceId: string): Promise<LiveTestClient> => {
    const client = await openLive({ port: on.port }, who.token);
    sockets.push(client);
    await client.next('ready');
    client.send({ type: 'subscribe', workspaceId });
    await client.next('presence');
    return client;
  };

  const host = async (on: Instance, session: SignedInUser): Promise<HostTestClient> => {
    const client = await openHost({ port: on.port }, session);
    sockets.push(client);
    return client;
  };
  const hello = (client: HostTestClient) => client.waitFor((frame) => frame.type === 'hello');

  /** The newest `presence` the client got, once it names exactly `names`. */
  const presenceNamed = async (client: LiveTestClient, names: readonly string[]): Promise<void> => {
    await vi.waitFor(
      () => {
        const last = client.messages.filter((m): m is Message<'presence'> => m.type === 'presence').at(-1);
        expect(last?.users.map((u) => u.name).sort()).toEqual([...names].sort());
      },
      { timeout: WAIT_MS },
    );
  };

  const push = (on: Instance, who: SignedInUser, workspaceId: string, content: string) =>
    call<SyncPushResponse>(on.h, who, 'POST', `/workspaces/${workspaceId}/sync/commits`, {
      parent: null,
      commits: [{ subject: 'Set x', at: AT, changes: [{ path: 'workspace.yaml', encoding: 'utf8', content }] }],
    });

  it('a push through one is a head on a live socket of the other within 2 s', async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    const workspaceId = await workspace(ana, [ben]);
    const watcher = await live(b, ben, workspaceId);
    const sent = Date.now();
    const pushed = await push(a, ana, workspaceId, 'x\n');
    expect(pushed.status).toBe(201);
    expect(await watcher.next('head')).toEqual({ type: 'head', workspaceId, head: pushed.body.head });
    expect(Date.now() - sent).toBeLessThan(2_000);
  });

  it('accessChanged and sessionEnded on one re-check and close the live and host sockets on the other', async () => {
    const ana = await user('ana', { serverAdmin: true });
    const ben = await user('ben');
    const workspaceId = await workspace(ana, [ben]);
    const watcher = await live(b, ben, workspaceId);
    const tab = await host(b, await browserSession(ben));
    await hello(tab);
    const hostsOnB = b.hosts().size;

    // A grant set through A's route: B's hub re-resolves Ben's role and tells him.
    const granted = await call(a.h, ana, 'PUT', `/workspaces/${workspaceId}/access/${ben.user.id}`, { role: 'editor' });
    expect(granted.status).toBe(204);
    expect(await watcher.next('access')).toEqual({ type: 'access', workspaceId });

    // Ben disabled through A: every session of his ends, so B closes his live socket and his host instance.
    const disabled = await call(a.h, ana, 'PATCH', `/users/${ben.user.id}`, { disabled: true });
    expect(disabled.status).toBe(200);
    expect(await watcher.next('session-ended')).toEqual({ type: 'session-ended' });
    expect((await watcher.closed).code).toBe(LIVE_CLOSE.unauthenticated);
    expect((await tab.closed).code).toBe(HOST_CLOSE.unauthenticated);
    await vi.waitFor(
      () => {
        expect(b.hosts().size).toBe(hostsOnB - 1);
      },
      { timeout: WAIT_MS },
    );
  });

  it('presence is the union of both instances, and drops the users of one that stops', async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    const workspaceId = await workspace(ana, [ben]);
    const c = await instance();
    const onB = await live(b, ben, workspaceId);
    const onC = await live(c, ana, workspaceId);
    const [anaName, benName] = [ana.user.displayName, ben.user.displayName];
    await presenceNamed(onB, [anaName, benName]);
    await presenceNamed(onC, [anaName, benName]);
    await c.server.close();
    expect((await onC.closed).code).toBe(LIVE_CLOSE.serviceRestart);
    await presenceNamed(onB, [benName]);
  });

  it('a tenant created on one resolves on the other, and a data key written on one is what the other reads', async () => {
    const heardOnB: unknown[] = [];
    b.server.ctx.hooks.tenantsChanged.push(remote((event) => heardOnB.push(event)));
    const { scope } = await new TenantAdmin(db, directoryOf(a.server.ctx.tenancy)).create({
      slug: 'acme',
      name: 'Acme',
    });
    await vi.waitFor(
      () => {
        expect(heardOnB).toHaveLength(1);
      },
      { timeout: 2_000, interval: 20 },
    );
    expect((await directoryOf(b.server.ctx.tenancy).get(scope.tenantId))?.slug).toBe('acme');
    // An event of the new tenant from A reaches B's listeners with its scope rebuilt by B.
    const accessOnB: AccessChangedEvent[] = [];
    b.server.ctx.hooks.accessChanged.push(cluster((event) => accessOnB.push(event)));
    const userId = newId();
    announce(a.server.ctx.hooks.accessChanged, { tenantId: scope.tenantId, tenant: scope, userId }, a.server.app.log);
    await vi.waitFor(
      () => {
        expect(accessOnB.find((event) => event.userId === userId)?.tenant).toEqual(scope);
      },
      { timeout: 2_000, interval: 20 },
    );

    const first = await b.server.ctx.tenancy.dataKey(scope);
    // The row loses its key, and A makes a new one by its compare-and-set: B's cache drops the old one.
    await db.query('update tenants set data_key = null where id = $1::uuid', [scope.tenantId]);
    const second = await a.server.ctx.tenancy.dataKey(scope);
    expect(second.equals(first)).toBe(false);
    await vi.waitFor(
      async () => {
        expect((await b.server.ctx.tenancy.dataKey(scope)).equals(second)).toBe(true);
      },
      { timeout: 2_000, interval: 20 },
    );
  });

  it('two pushes to one workspace through the two instances never interleave: the second waits', async () => {
    const ana = await user('ana');
    const workspaceId = await workspace(ana);
    const order: string[] = [];
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // Each server's push records when it holds the repository lock; A's holds it until the gate opens.
    for (const [on, name] of [
      [a, 'a'],
      [b, 'b'],
    ] as const) {
      const repos = on.server.ctx.repos;
      const withLock = repos.withLock.bind(repos);
      vi.spyOn(repos, 'withLock').mockImplementation((scope, id, fn) =>
        withLock(scope, id, async () => {
          if (id !== workspaceId) return fn();
          order.push(`${name} start`);
          if (name === 'a') await gate;
          try {
            return await fn();
          } finally {
            // A push refused under the lock (a stale parent) ends here too.
            order.push(`${name} end`);
          }
        }),
      );
    }
    try {
      const first = push(a, ana, workspaceId, 'a\n');
      await vi.waitFor(() => {
        expect(order).toEqual(['a start']);
      });
      const second = push(b, ana, workspaceId, 'b\n');
      // B's lock connection is queued behind A's in PostgreSQL, and its push has not started.
      await vi.waitFor(
        async () => {
          const { rows } = await db.query<{ n: number }>(
            `select count(*)::int as n from pg_locks where locktype = 'advisory' and not granted
               and classid::bigint = ($1::bigint & 4294967295) and objsubid = 2
               and pid in (select pid from pg_stat_activity where application_name = 'wirebench-server-repo-lock')`,
            [REPO_LOCK_CLASS],
          );
          expect(rows[0]!.n).toBeGreaterThanOrEqual(1);
        },
        { timeout: WAIT_MS },
      );
      expect(order).toEqual(['a start']);
      release();
      const [one, two] = await Promise.all([first, second]);
      expect(order).toEqual(['a start', 'a end', 'b start', 'b end']);
      expect(one.status).toBe(201);
      // B's push saw A's commit under the lock: its parent is no longer the head.
      expect(two.status).toBe(409);
    } finally {
      vi.restoreAllMocks();
    }
  });

  it('a host socket on the instance without the lease gets 4409, and takes the lease once the holder drains', async () => {
    const carol = await browserSession(await user('carol'));
    const c = await instance();
    const holding = await host(c, carol);
    await hello(holding);
    const refused = await host(b, carol);
    const closed = await refused.closedWith;
    expect(closed.code).toBe(HOST_CLOSE.leaseHeld);
    expect(closed.reason).toMatch(/^host-lease-held/);
    await c.server.close();
    expect((await holding.closed).code).toBe(HOST_CLOSE.unavailable);
    // At once: the drain gave the lease back, so B need not wait for it to expire.
    const taken = await host(b, carol);
    expect(await hello(taken)).toMatchObject({ type: 'hello' });
  });

  it('a viewer on one joins a share owned on the other, and control works both ways', async () => {
    const ana = await user('ana');
    const ben = await user('ben');
    const team = await seedTeam(a.h, { name: 'Ops', admins: [ana], members: [ben] });
    const workspaceId = await seedWorkspace(a.h, { team, name: 'Prod' });
    const created = await call<{ shareId: string }>(a.h, ana, 'POST', `/workspaces/${workspaceId}/terminal-shares`, {
      hostName: 'web',
      cols: 80,
      rows: 24,
    });
    expect(created.status).toBe(201);
    const { shareId } = created.body;
    const auth = (who: SignedInUser) => ({ type: 'auth', token: who.token, workspaceId, shareId });
    const owner: ShareClient = await openShare(a.port, auth(ana));
    sockets.push(owner);
    expect(await owner.next('ready')).toEqual({ type: 'ready', role: 'owner' });
    owner.sendBinary('$ uptime\r\n');

    const viewer = await openShare(b.port, auth(ben));
    sockets.push(viewer);
    expect(await viewer.next('viewer-ready')).toMatchObject({ type: 'viewer-ready', hostName: 'web' });
    expect(await viewer.binary(1)).toEqual(['$ uptime\r\n']);
    // Viewer to owner: the request reaches the holder.
    viewer.send({ type: 'request-control' });
    await expect
      .poll(() => owner.texts.filter((m) => m.type === 'presence').at(-1), { timeout: WAIT_MS })
      .toMatchObject({ viewers: [{ userId: ben.user.id, requesting: true }] });
    // Owner to viewer: the grant reaches B's socket, and the viewer's input comes back to the owner.
    owner.send({ type: 'grant', userId: ben.user.id });
    await expect
      .poll(() => viewer.texts.filter((m) => m.type === 'control').at(-1), { timeout: WAIT_MS })
      .toEqual({ type: 'control', userId: ben.user.id });
    const data = Buffer.from('ls\r').toString('base64');
    viewer.send({ type: 'input', data });
    expect(await owner.next('input')).toEqual({ type: 'input', userId: ben.user.id, data });
  });

  it('the 17th concurrent send is refused on either instance, and the per-minute budget is shared', async () => {
    const alice = await browserSession(await user('alice'));
    const bob = await browserSession(await user('bob'));
    const onA = await host(a, alice);
    const onB = await host(b, bob);
    await hello(onA);
    await hello(onB);
    const scope = a.h.tdb.scope;
    const settings = { sendsPerMinute: SENDS_PER_MINUTE, concurrentSends: CONCURRENT_SENDS };
    // Sixteen sends in flight, half on each instance's tenant pool: slots only, as a run takes them.
    const held: SendTake[] = [];
    for (const on of [a, b]) {
      const budgets = new SendBudgets({ db: on.server.ctx.tenancy.db, settings });
      for (let n = 0; n < CONCURRENT_SENDS / 2; n++) held.push(await budgets.take(scope, { token: false }));
    }
    expect(held.every((taken) => taken.ok)).toBe(true);
    const send = (client: HostTestClient, sendId: string) =>
      client.call('request.sendRest', { sendId, requestId: 'none' });
    for (const [client, sendId] of [
      [onA, 'a1'],
      [onB, 'b1'],
    ] as const) {
      expect(await send(client, sendId)).toMatchObject({ ok: false, error: { code: 'tenant-send-concurrency' } });
    }
    for (const taken of held) if (taken.ok) await taken.release();

    // A send through A spends the tenant's one token (the host answers it with its own error: nothing is open)...
    const first = await send(onA, 'a2');
    expect(first).toMatchObject({ ok: false });
    expect(JSON.stringify(first)).not.toContain('tenant-send');
    // ...and B's next send finds the budget spent.
    expect(await send(onB, 'b2')).toMatchObject({
      ok: false,
      error: { code: 'tenant-send-budget', details: { retryAfterMs: expect.any(Number) as number } },
    });
  });
});
