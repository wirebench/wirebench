/**
 * Live updates and terminal shares with two tenants under the forced policy (tenancy Task 18; Task 11 fix round M2).
 * Each tenant has a workspace with the very same id (workspace ids come from the desktop, spec §19.3 rule 2), so only
 * the socket's tenant can tell the rooms apart: a subscribe's role read and a share's `canView` have no tenant filter
 * of their own. The sockets go through `injectWS`, which can set the `Host` a tenant is served on.
 */
import { LIVE_CLOSE, LIVE_PATH, TERMINAL_SHARE_CLOSE, TERMINAL_SHARE_PATH } from '@wirebench/engine';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { announce } from '../../../../src/context.js';
import { newId } from '../../../../src/identity/tokens.js';
import { licensingModule } from '../../../../src/licensing/module.js';
import { liveModule } from '../../../../src/live/module.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { terminalSharesModule } from '../../../../src/terminal-shares/module.js';
import { describeDb } from '../../../helpers/database.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { license, testKeys } from '../../../helpers/licensing.js';
import { manualTimers } from '../../../helpers/timers.js';
import { openSocket, twoTenants, type Tenant, type TestSocket, type TwoTenants } from './two-tenants.js';

const keys = testKeys();

interface Cast {
  /** A server admin: admin of any workspace row a read finds, so only the policy keeps A's from it (Task 18 review I1). */
  readonly root: SignedInUser;
  readonly owner: SignedInUser;
  readonly viewer: SignedInUser;
  readonly teamId: string;
}

describeDb('live updates and terminal shares in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  const timers = manualTimers();
  /** One workspace id in both tenants; in A, a second one B has nothing at. */
  const shared = newId();
  const onlyA = newId();
  const casts: Partial<Record<'acme' | 'beta', Cast>> = {};
  const cast = (tenant: Tenant) => casts[tenant.slug]!;
  const sockets: TestSocket[] = [];
  beforeAll(async () => {
    t = await twoTenants({
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        teamsModule({ now: () => clock.now }),
        liveModule({ now: () => clock.now, setTimer: timers.setTimer }),
        terminalSharesModule({ now: () => clock.now, setTimer: timers.setTimer }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      const root = await tenant.user({ email: 'root@example.com', serverAdmin: true });
      const installed = await tenant.call(root, 'PUT', '/license', {
        license: license(keys, { edition: 'enterprise' }),
      });
      expect(installed.status).toBe(200);
      const owner = await tenant.user({ email: 'owner@example.com' });
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
      for (const id of tenant === t.a ? [shared, onlyA] : [shared]) {
        await teamsRepo.insertWorkspace(tenant.tdb, {
          id,
          name: `Prod ${tenant.slug} ${id}`,
          teamId: team.id,
          defaultRole: 'viewer',
          createdBy: null,
          at: t.h.clock.now,
        });
      }
      casts[tenant.slug] = { root, owner, viewer, teamId: team.id };
    }
  });
  afterAll(async () => {
    for (const socket of sockets) socket.close();
    await Promise.all(sockets.map((socket) => socket.closed));
    // An injected socket stays in the WebSocket server's client set after it closed, so the live module's
    // shutdown waits for its 2 s grace timer (live/module.ts CLOSE_GRACE_MS), which is a manual one here.
    const closing = t.close();
    await vi.waitFor(() => expect(timers.fire(2_000)).toBeGreaterThan(0));
    await closing;
  });

  const live = async (tenant: Tenant, token: string): Promise<TestSocket> => {
    const socket = await openSocket(t, tenant, LIVE_PATH);
    sockets.push(socket);
    socket.send({ type: 'auth', token });
    return socket;
  };
  const subscribed = async (tenant: Tenant, workspaceId: string): Promise<TestSocket> => {
    const socket = await live(tenant, cast(tenant).viewer.token);
    await socket.next('ready');
    socket.send({ type: 'subscribe', workspaceId });
    // Presence answers a subscribe that was let in.
    await socket.next('presence');
    return socket;
  };

  it("A's token on B's host is refused at the live socket's auth", async () => {
    const socket = await live(t.b, cast(t.a).viewer.token);
    expect(await socket.closed).toBe(LIVE_CLOSE.unauthenticated);
  });

  it("B's socket, with B's server admin's token on B's host, is refused A's workspace id", async () => {
    const socket = await live(t.b, cast(t.b).root.token);
    await socket.next('ready');
    socket.send({ type: 'subscribe', workspaceId: onlyA });
    expect(await socket.next('refused')).toEqual({
      type: 'refused',
      workspaceId: onlyA,
      code: 'teams-workspace-not-found',
    });
  });

  it("announcements in A reach A's room only, though B's room has the same workspace id", async () => {
    const inA = await subscribed(t.a, shared);
    const inB = await subscribed(t.b, shared);
    const head = 'a'.repeat(40);
    announce(
      t.h.hooks.headMoved,
      { tenantId: t.a.scope.tenantId, workspaceId: shared, head, tokenId: newId() },
      t.h.app.log,
    );
    const run = { workspaceId: shared, scheduleId: newId(), runId: newId(), status: 'passed' as const };
    announce(t.h.hooks.scheduleRunFinished, { tenantId: t.a.scope.tenantId, ...run }, t.h.app.log);
    expect(await inA.next('head')).toMatchObject({ workspaceId: shared, head });
    expect(await inA.next('schedule-run')).toMatchObject({ runId: run.runId });
    // An access change in A re-checks A's room only. A's viewer leaves A's team first, so the re-check has an
    // effect to wait for in A before B is looked at; B's viewer, no one in A, must not be dropped (Task 18 review M1).
    await teamsRepo.deleteMember(t.a.tdb, cast(t.a).teamId, cast(t.a).viewer.user.id);
    announce(
      t.h.hooks.accessChanged,
      { tenantId: t.a.scope.tenantId, tenant: t.a.scope, workspaceId: shared },
      t.h.app.log,
    );
    expect(await inA.next('access')).toEqual({ type: 'access', workspaceId: shared });
    // Then B's own head: B's socket is still subscribed, and saw nothing of A's before it.
    const headB = 'b'.repeat(40);
    announce(
      t.h.hooks.headMoved,
      { tenantId: t.b.scope.tenantId, workspaceId: shared, head: headB, tokenId: newId() },
      t.h.app.log,
    );
    expect(await inB.next('head')).toMatchObject({ head: headB });
    const seen = inB.messages.map((message) => message.type);
    expect(seen).not.toContain('schedule-run');
    expect(seen).not.toContain('access');
    expect(seen).not.toContain('refused');
    expect(inB.messages.filter((message) => message.type === 'head')).toHaveLength(1);
    // A's viewer back on A's team, for the share case.
    await teamsRepo.insertMember(t.a.tdb, {
      teamId: cast(t.a).teamId,
      userId: cast(t.a).viewer.user.id,
      role: 'member',
      at: t.h.clock.now,
    });
  });

  const shareAuth = (token: string, workspaceId: string, shareId: string) => ({
    type: 'auth',
    token,
    workspaceId,
    shareId,
  });
  const createShare = async (tenant: Tenant): Promise<string> => {
    const res = await tenant.call<{ shareId: string }>(
      cast(tenant).owner,
      'POST',
      `/workspaces/${shared}/terminal-shares`,
      {
        hostName: 'web',
        cols: 80,
        rows: 24,
      },
    );
    expect(res.status).toBe(201);
    return res.body.shareId;
  };

  it("B cannot join A's terminal share: A's share id with B's workspace of the same id is not found", async () => {
    const shareId = await createShare(t.a);
    const owner = await openSocket(t, t.a, TERMINAL_SHARE_PATH);
    sockets.push(owner);
    owner.send(shareAuth(cast(t.a).owner.token, shared, shareId));
    expect(await owner.next('ready')).toEqual({ type: 'ready', role: 'owner' });
    // The info route and the socket, as B's viewer with B's token on B's host.
    const info = await t.b.call<{ code: string }>(
      cast(t.b).viewer,
      'GET',
      `/workspaces/${shared}/terminal-shares/${shareId}`,
    );
    expect(info.status).toBe(404);
    expect(info.body.code).toBe('terminal-share-not-found');
    const viewer = await openSocket(t, t.b, TERMINAL_SHARE_PATH);
    sockets.push(viewer);
    viewer.send(shareAuth(cast(t.b).viewer.token, shared, shareId));
    expect(await viewer.closed).toBe(TERMINAL_SHARE_CLOSE.notFound);
    // A's token on B's host is no one.
    const stranger = await openSocket(t, t.b, TERMINAL_SHARE_PATH);
    sockets.push(stranger);
    stranger.send(shareAuth(cast(t.a).viewer.token, shared, shareId));
    expect(await stranger.closed).toBe(TERMINAL_SHARE_CLOSE.unauthenticated);
    // A's own viewer still joins.
    const inA = await openSocket(t, t.a, TERMINAL_SHARE_PATH);
    sockets.push(inA);
    inA.send(shareAuth(cast(t.a).viewer.token, shared, shareId));
    expect(await inA.next('viewer-ready')).toMatchObject({ hostName: 'web' });
  });
});
