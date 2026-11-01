/**
 * Server-sync, webhook capture and CI tokens with two tenants under the forced policy (tenancy Task 18; Task 10's
 * listed cases). A catch URL's secret, a capture id and a CI token hash are looked up with no tenant filter of their
 * own: the policy and the request's `Host` keep each lookup in one tenant.
 */
import { CATCH_URL_DEFAULT_RESPONSE, type SyncChange, type SyncPushCommit } from '@wirebench/engine';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { ciTokensModule } from '../../../../src/ci-tokens/module.js';
import type { CaptureReceivedEvent } from '../../../../src/context.js';
import { hooksModule } from '../../../../src/hooks/module.js';
import * as hooksRepo from '../../../../src/hooks/repo.js';
import { mintCatchSecret } from '../../../../src/hooks/secret.js';
import { SWEEP_INTERVAL_MS } from '../../../../src/hooks/sweep.js';
import { newId } from '../../../../src/identity/tokens.js';
import { syncModule } from '../../../../src/sync/module.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { describeDb } from '../../../helpers/database.js';
import { newCapture } from '../../../helpers/hooks.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { manualTimers } from '../../../helpers/timers.js';
import { countIn, twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

const AT = '2026-09-24T12:00:00.000Z';
const DAY = 86_400_000;
const text = (path: string, content: string): SyncChange => ({ path, encoding: 'utf8', content });
const commit = (subject: string, changes: SyncChange[]): SyncPushCommit => ({ subject, at: AT, changes });

interface Cast {
  readonly admin: SignedInUser;
  readonly workspaceId: string;
}

describeDb('server-sync, webhook capture and CI tokens in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  const timers = manualTimers();
  const casts: Partial<Record<'acme' | 'beta', Cast>> = {};
  const cast = (tenant: Tenant) => casts[tenant.slug]!;
  beforeAll(async () => {
    t = await twoTenants({
      env: { WIREBENCH_SERVER_HOOKS_MAX_AGE_DAYS: '7' },
      modules: (clock) => [
        teamsModule({ now: () => clock.now }),
        syncModule(),
        hooksModule({ now: () => clock.now, setTimer: timers.setTimer }),
        ciTokensModule({ now: () => clock.now }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      const admin = await tenant.user({ email: 'admin@example.com' });
      const team = await teamsRepo.insertTeam(tenant.tdb, { id: newId(), name: 'Payments QA', at: t.h.clock.now });
      await teamsRepo.insertMember(tenant.tdb, {
        teamId: team.id,
        userId: admin.user.id,
        role: 'admin',
        at: t.h.clock.now,
      });
      // Distinct ids: the repository store is keyed by id alone until the per-tenant layout (plan Task 21).
      const workspaceId = newId();
      await teamsRepo.insertWorkspace(tenant.tdb, {
        id: workspaceId,
        name: 'Staging',
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: t.h.clock.now,
      });
      await t.h.repos.withLock(tenant.scope, workspaceId, () => t.h.repos.create(workspaceId));
      casts[tenant.slug] = { admin, workspaceId };
    }
  });
  afterAll(() => t.close());

  const seedHook = (tenant: Tenant, secret = mintCatchSecret()) =>
    hooksRepo.insertCatchUrl(tenant.tdb, {
      id: newId(),
      workspaceId: cast(tenant).workspaceId,
      name: `Payments ${newId()}`,
      secret,
      enabled: true,
      response: CATCH_URL_DEFAULT_RESPONSE,
      createdBy: null,
      at: t.h.clock.now,
    });

  it("B cannot read the head, snapshot, changes or log of A's workspace by id, nor push to it", async () => {
    const ws = `/workspaces/${cast(t.a).workspaceId}`;
    const pushed = await t.a.call<{ head: string }>(cast(t.a).admin, 'POST', `${ws}/sync/commits`, {
      parent: null,
      commits: [commit('One', [text('workspace.yaml', 'a\n')])],
    });
    expect(pushed.status).toBe(201);
    const head = pushed.body.head;
    const reads = [
      ['GET', `${ws}/sync/head`],
      ['GET', `${ws}/sync/snapshot?at=${head}`],
      ['GET', `${ws}/sync/changes?from=${head}&to=${head}`],
      ['GET', `${ws}/sync/log`],
    ] as const;
    for (const [method, path] of reads) {
      expect((await t.a.call(cast(t.a).admin, method, path)).status, `A ${path}`).toBe(200);
      const res = await t.b.call<{ code: string }>(cast(t.b).admin, method, path);
      expect(res.status, `B ${path}`).toBe(404);
      expect(res.body.code, `B ${path}`).toBe('teams-workspace-not-found');
    }
    const push = await t.b.call(cast(t.b).admin, 'POST', `${ws}/sync/commits`, {
      parent: head,
      commits: [commit('Planted', [text('workspace.yaml', 'b\n')])],
    });
    expect(push.status).toBe(404);
    expect((await t.a.call<{ head: string }>(cast(t.a).admin, 'GET', `${ws}/sync/head`)).body.head).toBe(head);
  });

  it("A's catch URL secret on B's host is 404 and stores nothing in either tenant", async () => {
    const hook = await seedHook(t.a);
    const send = (tenant: Tenant) =>
      tenant.inject({
        method: 'POST',
        url: `/hooks/${hook.secret}/events`,
        headers: { 'content-type': 'application/json' },
        payload: '{}',
      });
    expect((await send(t.b)).statusCode).toBe(404);
    expect(await countIn(t.a, 'captures', 'catch_url_id = $1', [hook.id])).toBe(0);
    expect(await countIn(t.b, 'captures')).toBe(0);
    expect((await send(t.a)).statusCode).toBe(200);
    expect(await countIn(t.a, 'captures', 'catch_url_id = $1', [hook.id])).toBe(1);
  });

  it('one secret in both tenants (unique per tenant): each Host stores in its own, and announces its own tenant', async () => {
    const secret = mintCatchSecret();
    const inA = await seedHook(t.a, secret);
    const inB = await seedHook(t.b, secret);
    const events: CaptureReceivedEvent[] = [];
    t.h.hooks.captureReceived.push((event) => events.push(event));
    const res = await t.a.inject({ method: 'POST', url: `/hooks/${secret}`, payload: 'x' });
    expect(res.statusCode).toBe(200);
    expect(await countIn(t.a, 'captures', 'catch_url_id = $1', [inA.id])).toBe(1);
    expect(await countIn(t.b, 'captures', 'catch_url_id = $1', [inB.id])).toBe(0);
    expect(events.map((event) => [event.tenantId, event.hookId])).toEqual([[t.a.scope.tenantId, inA.id]]);
  });

  it("A's catch URL and capture ids, sent under B's workspace by B's admin, are 404", async () => {
    const hook = await seedHook(t.a);
    const capture = newCapture(hook.id);
    await hooksRepo.insertCapture(t.a.tdb, capture);
    const ws = `/workspaces/${cast(t.b).workspaceId}`;
    const refused = [
      ['PATCH', `${ws}/hooks/${hook.id}`, { name: 'Taken' }],
      ['POST', `${ws}/hooks/${hook.id}/rotate`, undefined],
      ['GET', `${ws}/hooks/${hook.id}/captures`, undefined],
      ['GET', `${ws}/hooks/${hook.id}/captures/${capture.id}`, undefined],
      ['DELETE', `${ws}/hooks/${hook.id}/captures`, undefined],
      ['DELETE', `${ws}/hooks/${hook.id}`, undefined],
    ] as const;
    for (const [method, path, payload] of refused) {
      expect((await t.b.call(cast(t.b).admin, method, path, payload)).status, `${method} ${path}`).toBe(404);
    }
    const listed = await t.b.call<{ id: string }[]>(cast(t.b).admin, 'GET', `${ws}/hooks`);
    expect(listed.body.map((row) => row.id)).not.toContain(hook.id);
    expect(await countIn(t.a, 'captures', 'id = $1', [capture.id])).toBe(1);
    expect((await hooksRepo.catchUrlInWorkspace(t.a.tdb, cast(t.a).workspaceId, hook.id))?.name).toBe(hook.name);
  });

  it("A's CI token on B's host is 401", async () => {
    const ws = `/workspaces/${cast(t.a).workspaceId}`;
    const ci = await t.a.call<{ token: string }>(cast(t.a).admin, 'POST', `${ws}/ci-tokens`, { name: 'CI' });
    expect(ci.status).toBe(201);
    const asCi = (tenant: Tenant) =>
      tenant.inject({ method: 'GET', url: '/api/v1/ci/whoami', headers: { authorization: `Bearer ${ci.body.token}` } });
    expect((await asCi(t.a)).statusCode).toBe(200);
    expect((await asCi(t.b)).statusCode).toBe(401);
  });

  it('capture retention trims both tenants, and its batch of one in A deletes one of A’s', async () => {
    const old = new Date(t.h.clock.now.getTime() - 8 * DAY);
    const seeded = await Promise.all(
      [t.a, t.b].map(async (tenant) => {
        const hook = await seedHook(tenant);
        const fresh = newCapture(hook.id, { receivedAt: t.h.clock.now });
        for (let i = 0; i < 3; i += 1)
          await hooksRepo.insertCapture(tenant.tdb, newCapture(hook.id, { receivedAt: old }));
        await hooksRepo.insertCapture(tenant.tdb, fresh);
        return { tenant, hookId: hook.id, fresh: fresh.id };
      }),
    );
    // The delete names no tenant and limits in a sub-select: a batch of one in A's unit is one of A's.
    const cutoff = new Date(t.h.clock.now.getTime() - 7 * DAY);
    expect(await t.a.tdb.transaction((tx) => hooksRepo.deleteCapturesBefore(tx, cutoff, 1))).toBe(1);
    expect(await countIn(t.a, 'captures', 'received_at < $1', [cutoff])).toBe(2);
    expect(await countIn(t.b, 'captures', 'received_at < $1', [cutoff])).toBe(3);
    expect(timers.fire(SWEEP_INTERVAL_MS)).toBeGreaterThan(0);
    for (const { tenant, hookId, fresh } of seeded) {
      await expect
        .poll(async () => (await hooksRepo.listCaptures(tenant.tdb, hookId, {}, 10)).map((c) => c.id))
        .toEqual([fresh]);
    }
  });

  it('one workspace id in both tenants locks two repository-store queues', async () => {
    const id = newId();
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    const inA = t.h.repos.withLock(t.a.scope, id, () => held);
    // B's turn on the same id runs while A's is held; a shared queue would wait for A.
    let ranInB = false;
    await t.h.repos.withLock(t.b.scope, id, () => {
      ranInB = true;
      return Promise.resolve();
    });
    expect(ranInB).toBe(true);
    release();
    await inA;
  });
});
