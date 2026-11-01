/**
 * The server host with two tenants under the forced policy (tenancy Task 18). A host socket is a browser session's
 * on its tenant's host: A's cookie on B's host is no one, and B's user cannot join A's workspace into its checkout,
 * by A's id or by a project path that climbs out of its own directory. The per-tenant directory layout itself is
 * plan Task 21's.
 */
import { randomBytes } from 'node:crypto';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { HOST_CLOSE } from '../../../../src/host/errors.js';
import { hostModule } from '../../../../src/host/module.js';
import { hostDirectories } from '../../../../src/host/server-platform.js';
import { sessionCookieName } from '../../../../src/identity/cookies.js';
import { newId } from '../../../../src/identity/tokens.js';
import { liveModule } from '../../../../src/live/module.js';
import { syncModule } from '../../../../src/sync/module.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { browserBuildFixture, type BrowserBuildFixture } from '../../../helpers/browser-build.js';
import { describeDb } from '../../../helpers/database.js';
import { seedSlice2, storedCookie } from '../../../helpers/host.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { workspaceSnapshot } from '../../../helpers/schedule-runs.js';
import { markStepsDone } from '../../../helpers/tenancy.js';
import { manualTimers } from '../../../helpers/timers.js';
import { openSocket, twoTenants, type Tenant, type TestSocket, type TwoTenants } from './two-tenants.js';

describeDb('the server host in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  let build: BrowserBuildFixture;
  const timers = manualTimers();
  const hostTimers = manualTimers();
  const users: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  const user = (tenant: Tenant) => users[tenant.slug]!;
  /** A's workspace, which B has nothing at. */
  const onlyA = newId();
  const sockets: TestSocket[] = [];
  beforeAll(async () => {
    build = await browserBuildFixture();
    t = await twoTenants({
      env: {
        WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
        WIREBENCH_SERVER_SECRETS_KEY: randomBytes(32).toString('base64'),
        WIREBENCH_SERVER_HOST_IDLE_MINUTES: '30',
      },
      modules: (clock) => [
        teamsModule({ now: () => clock.now }),
        syncModule(),
        liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
        hostModule({ now: () => clock.now, setTimer: hostTimers.setTimer, browserRoot: build.root }),
      ],
    });
    await markStepsDone(t.h.db.owner);
    for (const tenant of [t.a, t.b]) {
      // Server admins: admin of any workspace row a read finds, so only the policy keeps B's from A's (Task 18 review I1).
      users[tenant.slug] = await tenant.user({ email: 'alice@example.com', kind: 'browser', serverAdmin: true });
    }
    const team = await teamsRepo.insertTeam(t.a.tdb, { id: newId(), name: 'Ops', at: t.h.clock.now });
    await teamsRepo.insertMember(t.a.tdb, {
      teamId: team.id,
      userId: user(t.a).user.id,
      role: 'admin',
      at: t.h.clock.now,
    });
    await teamsRepo.insertWorkspace(t.a.tdb, {
      id: onlyA,
      name: 'Staging',
      teamId: team.id,
      defaultRole: 'viewer',
      createdBy: null,
      at: t.h.clock.now,
    });
    await t.h.repos.withLock(t.a.scope, onlyA, () => t.h.repos.create(t.a.scope, onlyA));
    // A shared workspace's first commit, its workspace.yaml naming the server workspace's id.
    const files = (await workspaceSnapshot([])).map((file) =>
      file.path === 'workspace.yaml'
        ? {
            path: file.path,
            encoding: 'utf8' as const,
            content: Buffer.from(file.content, file.encoding === 'base64' ? 'base64' : 'utf8')
              .toString('utf8')
              .replace('workspace-smoke', onlyA),
          }
        : file,
    );
    const pushed = await t.a.call(user(t.a), 'POST', `/workspaces/${onlyA}/sync/commits`, {
      parent: null,
      commits: [{ subject: 'Start', at: '2026-09-24T12:00:00.000Z', changes: files }],
    });
    expect(pushed.status).toBe(201);
  });
  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await Promise.all(sockets.map((socket) => socket.closed));
    // Injected sockets stay in the WebSocket server's client set: the live module's 2 s grace timer is a manual one.
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

  const host = async (tenant: Tenant, cookieOf: SignedInUser): Promise<TestSocket> => {
    const socket = await openSocket(t, tenant, '/api/v1/host', {
      origin: tenant.origin,
      cookie: `${sessionCookieName(tenant.origin)}=${cookieOf.token}`,
    });
    sockets.push(socket);
    return socket;
  };
  let nextId = 1;
  const call = async (socket: TestSocket, channel: string, request?: unknown) => {
    const id = nextId++;
    socket.send({ id, channel, ...(request !== undefined ? { request } : {}) });
    return socket.waitFor((frame) => frame.id === id, channel);
  };

  it("A's session cookie on B's host is no one: the host socket closes 4401 before any frame", async () => {
    const socket = await host(t.b, user(t.a));
    expect(await socket.closed).toBe(HOST_CLOSE.unauthenticated);
    expect(socket.messages).toEqual([]);
  });

  it("B's host cannot join A's workspace, and nothing of it reaches B's user's directory", async () => {
    const inB = await host(t.b, user(t.b));
    await inB.next('hello');
    const joined = await call(inB, 'workspace.joinFromServer', { url: t.b.origin, workspaceId: onlyA });
    expect(joined).toMatchObject({ ok: false, error: { code: 'teams-workspace-not-found' } });
    // A project path that climbs towards A's user's directory opens nothing either.
    expect(await call(inB, 'secretScan.scan', { projectId: `../../${user(t.a).user.id}` })).toMatchObject({
      ok: false,
      error: { code: 'unknown-project' },
    });
    const dirs = hostDirectories(t.h.dataDir, t.b.scope, user(t.b).user.id);
    const checkedOut = await readdir(dirs.checkout, { recursive: true }).catch(() => [] as string[]);
    expect(checkedOut.join('\n')).not.toContain(onlyA);
    // A's own host joins it.
    const inA = await host(t.a, user(t.a));
    await inA.next('hello');
    const own = await call(inA, 'workspace.joinFromServer', { url: t.a.origin, workspaceId: onlyA });
    expect(own.ok, JSON.stringify(own)).toBe(true);
  });

  it("a non-default tenant's host does not open a blob sealed under the root's user key (Task 23 review M2)", async () => {
    // A fresh user of A, so no host of theirs has a jar loaded yet.
    const carol = await t.a.user({ email: 'carol@example.com', kind: 'browser' });
    const teamId = (
      await t.a.tdb.query<{ teamId: string }>('select team_id as "teamId" from workspaces where id = $1', [onlyA])
    ).rows[0]!.teamId;
    await teamsRepo.insertMember(t.a.tdb, { teamId, userId: carol.user.id, role: 'member', at: t.h.clock.now });
    await teamsRepo.upsertGrant(t.a.tdb, {
      workspaceId: onlyA,
      userId: carol.user.id,
      role: 'editor',
      at: t.h.clock.now,
    });
    const checkout = hostDirectories(t.h.dataDir, t.a.scope, carol.user.id).checkout;
    await seedSlice2(checkout, t.h.ctx.config.secretsKey!, carol.user.id, {
      workspaceId: onlyA,
      label: 'wirebench-secret:project-billing:API_KEY',
      secret: 'root-sealed-0123456789',
      cookie: [storedCookie('session', 'root-sealed-cookie', 'cookies.example.test')],
    });
    const inA = await host(t.a, carol);
    await inA.next('hello');
    const joined = await call(inA, 'workspace.joinFromServer', { url: t.a.origin, workspaceId: onlyA });
    expect(joined.ok, JSON.stringify(joined)).toBe(true);
    // The jar does not open under A's user key, and nothing falls back to the root: it is set aside.
    await vi.waitFor(async () => {
      expect(await readdir(join(checkout, 'cookie-jars'))).toContain(`${onlyA}.json.corrupt`);
    });
    expect(await call(inA, 'cookies.list')).toMatchObject({ ok: true, value: { cookies: [] } });
  });
});
