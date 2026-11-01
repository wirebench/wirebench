/**
 * Teams-access and licensing with two tenants under the forced policy (tenancy Task 18; Task 9 review M7, M8). The
 * license, seat and role reads have no tenant filter of their own: each case here shows the policy is what keeps
 * them in the request's tenant.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { newId } from '../../../../src/identity/tokens.js';
import { licensingModule } from '../../../../src/licensing/module.js';
import { schedulesModule } from '../../../../src/schedules/module.js';
import { teamsModule } from '../../../../src/teams/module.js';
import * as teamsRepo from '../../../../src/teams/repo.js';
import { describeDb } from '../../../helpers/database.js';
import type { SignedInUser } from '../../../helpers/identity.js';
import { license, testKeys } from '../../../helpers/licensing.js';
import { SCHEDULES_KEY } from '../../../helpers/schedules.js';
import { countIn, twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

const PASSWORD = 'correct horse battery';
const keys = testKeys();

describeDb('teams and licensing in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  const roots: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  const root = (tenant: Tenant) => roots[tenant.slug]!;
  beforeAll(async () => {
    t = await twoTenants({
      env: { WIREBENCH_SERVER_SCHEDULES_SECRET_KEY: SCHEDULES_KEY },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        teamsModule({ now: () => clock.now }),
        schedulesModule({ now: () => clock.now, startScheduler: false }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      roots[tenant.slug] = await tenant.user({ email: 'root@example.com', serverAdmin: true });
    }
  });
  afterAll(() => t.close());

  const createTeam = async (tenant: Tenant, name: string) => {
    const res = await tenant.call<{ id: string }>(root(tenant), 'POST', '/teams', { name });
    expect(res.status, JSON.stringify(res.body)).toBe(201);
    return res.body.id;
  };
  const createWorkspace = async (tenant: Tenant, teamId: string, body: object) =>
    tenant.call<{ id: string; code?: string }>(root(tenant), 'POST', `/teams/${teamId}/workspaces`, body);

  it('team names are unique per tenant: "Platform" exists in both', async () => {
    const inA = await createTeam(t.a, 'Platform');
    const inB = await createTeam(t.b, 'Platform');
    expect(inA).not.toBe(inB);
    // Unique inside one tenant still.
    expect((await t.a.call<{ code: string }>(root(t.a), 'POST', '/teams', { name: 'platform' })).status).toBe(409);
    expect((await t.b.call<{ id: string }[]>(root(t.b), 'GET', '/teams')).body.map((team) => team.id)).toEqual([inB]);
  });

  it("B cannot read, rename, grant on or delete A's team or workspace by id", async () => {
    const teamId = await createTeam(t.a, 'Payments');
    const created = await createWorkspace(t.a, teamId, { name: 'Staging' });
    expect(created.status).toBe(201);
    const workspaceId = created.body.id;
    const member = await t.a.user({ email: 'member@example.com' });
    await teamsRepo.insertMember(t.a.tdb, { teamId, userId: member.user.id, role: 'member', at: t.h.clock.now });
    const refused = [
      ['GET', `/teams/${teamId}/members`, undefined, 'teams-team-not-found'],
      ['PATCH', `/teams/${teamId}`, { name: 'Taken over' }, 'teams-team-not-found'],
      ['POST', `/teams/${teamId}/workspaces`, { name: 'Planted' }, 'teams-team-not-found'],
      ['DELETE', `/teams/${teamId}`, undefined, undefined],
      ['GET', `/workspaces/${workspaceId}`, undefined, 'teams-workspace-not-found'],
      ['PATCH', `/workspaces/${workspaceId}`, { name: 'Taken over' }, 'teams-workspace-not-found'],
      ['GET', `/workspaces/${workspaceId}/access`, undefined, 'teams-workspace-not-found'],
      ['PUT', `/workspaces/${workspaceId}/access/${member.user.id}`, { role: 'admin' }, 'teams-workspace-not-found'],
      ['DELETE', `/workspaces/${workspaceId}/access/${member.user.id}`, undefined, 'teams-workspace-not-found'],
      ['DELETE', `/workspaces/${workspaceId}`, undefined, 'teams-workspace-not-found'],
    ] as const;
    for (const [method, path, payload, code] of refused) {
      const res = await t.b.call<{ code: string }>(root(t.b), method, path, payload);
      expect(res.status, `${method} ${path}`).toBe(404);
      if (code !== undefined) expect(res.body.code, `${method} ${path}`).toBe(code);
    }
    // A's rows are as they were, and B's list never shows them.
    expect((await teamsRepo.teamById(t.a.tdb, teamId))?.name).toBe('Payments');
    expect((await teamsRepo.workspaceById(t.a.tdb, workspaceId))?.name).toBe('Staging');
    expect(
      await countIn(t.a, 'workspace_grants', 'workspace_id = $1 and user_id = $2', [workspaceId, member.user.id]),
    ).toBe(0);
    const listed = await t.b.call<{ id: string }[]>(root(t.b), 'GET', '/workspaces');
    expect(listed.body.map((ws) => ws.id)).not.toContain(workspaceId);
    // A server admin of A is no one in B: A's token is refused on B's host.
    expect((await t.b.call(root(t.a), 'GET', '/teams')).status).toBe(401);
  });

  it('one workspace id in both tenants: two rows, each read in its own tenant only', async () => {
    const id = newId();
    for (const tenant of [t.a, t.b]) {
      const team = await teamsRepo.insertTeam(tenant.tdb, {
        id: newId(),
        name: `Shared ${tenant.slug}`,
        at: t.h.clock.now,
      });
      await teamsRepo.insertWorkspace(tenant.tdb, {
        id,
        name: `Copy in ${tenant.slug}`,
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: t.h.clock.now,
      });
    }
    expect((await teamsRepo.workspaceById(t.a.tdb, id))?.name).toBe('Copy in acme');
    expect((await teamsRepo.workspaceById(t.b.tdb, id))?.name).toBe('Copy in beta');
    const viaRoute = await t.b.call<{ name: string }>(root(t.b), 'GET', `/workspaces/${id}`);
    expect(viaRoute.body.name).toBe('Copy in beta');
    await teamsRepo.deleteWorkspace(t.b.tdb, id);
    expect((await teamsRepo.workspaceById(t.a.tdb, id))?.name).toBe('Copy in acme');
  });

  it("B creating a workspace with A's id is refused 409 until the per-tenant layout, and A's is left alone", async () => {
    // Plan Task 21 (Task 9 review M8): the repository store is keyed by id alone until then, so B's create meets
    // A's repository and rolls back. Task 21 turns this into 201 with two repositories.
    const inA = await createWorkspace(t.a, await createTeam(t.a, 'Desk A'), { name: 'Mine', id: newId() });
    expect(inA.status).toBe(201);
    const id = inA.body.id;
    const inB = await createWorkspace(t.b, await createTeam(t.b, 'Desk B'), { name: 'Mine too', id });
    expect(inB.status).toBe(409);
    expect(inB.body.code).toBe('teams-workspace-exists');
    expect(await teamsRepo.workspaceById(t.b.tdb, id)).toBeUndefined();
    expect((await teamsRepo.workspaceById(t.a.tdb, id))?.name).toBe('Mine');
    expect(await t.h.repos.exists(id)).toBe(true);
  });

  it('a license installed in A leaves B on Community: meta, the feature gate and the seat cap', async () => {
    const install = await t.a.call(root(t.a), 'PUT', '/license', { license: license(keys, { edition: 'enterprise' }) });
    expect(install.status).toBe(200);
    const meta = async (tenant: Tenant) =>
      (await tenant.call<{ edition: string }>(undefined, 'GET', '/meta')).body.edition;
    expect(await meta(t.a)).toBe('enterprise');
    expect(await meta(t.b)).toBe('community');
    expect((await t.b.call<{ edition: string }>(root(t.b), 'GET', '/license')).body.edition).toBe('community');
    // requireFeature: scheduled runs are on in A only.
    const teamId = (await t.a.call<{ id: string }[]>(root(t.a), 'GET', '/teams')).body[0]!.id;
    const wsA = (await createWorkspace(t.a, teamId, { name: 'Gated' })).body.id;
    const wsB = (
      await createWorkspace(t.b, (await t.b.call<{ id: string }[]>(root(t.b), 'GET', '/teams')).body[0]!.id, {
        name: 'Gated',
      })
    ).body.id;
    expect((await t.a.call(root(t.a), 'GET', `/workspaces/${wsA}/schedules`)).status).toBe(200);
    const gated = await t.b.call<{ code: string }>(root(t.b), 'GET', `/workspaces/${wsB}/schedules`);
    expect(gated.status).toBe(403);
  });

  it("seats count only the tenant's users, and a remove in B leaves A's license", async () => {
    // B is on Community (5 seats): its root plus four more fill it, whatever A has.
    for (let i = 0; i < 6; i += 1) await t.a.user({ email: `a-extra${i}@example.com` });
    const used = async (tenant: Tenant) =>
      (await tenant.call<{ seats: { used: number } }>(root(tenant), 'GET', '/license')).body.seats.used;
    const usedInB = await used(t.b);
    expect(usedInB).toBe(await countIn(t.b, 'users', 'disabled_at is null'));
    expect(await used(t.a)).toBe(await countIn(t.a, 'users', 'disabled_at is null'));
    expect(await used(t.a)).toBeGreaterThan(usedInB);
    for (let i = usedInB; i < 5; i += 1) await t.b.user({ email: `b-fill${i}@example.com` });
    const refused = await t.b.call<{ code: string }>(root(t.b), 'POST', '/invitations', { email: 'sixth@example.com' });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('licensing-seat-limit');
    expect((await t.a.call(root(t.a), 'POST', '/invitations', { email: 'sixth@example.com' })).status).toBe(201);
    // B removing (nothing) leaves A's row.
    expect((await t.b.call(root(t.b), 'DELETE', '/license')).status).toBe(204);
    expect((await t.a.call<{ edition: string }>(root(t.a), 'GET', '/license')).body.edition).toBe('enterprise');
    expect(await countIn(t.a, 'license')).toBe(1);
  });

  it("two acceptances racing for a tenant's last seat are serialised, and A's seat lock never blocks B", async () => {
    // B (Community, 5 seats) is full from the case above: free it down to one seat left.
    const disable = async (tenant: Tenant, email: string) =>
      tenant.tdb.query('update users set disabled_at = $2 where email_lower = $1', [email, t.h.clock.now]);
    for (let i = 0; i < 5; i += 1) await disable(t.b, `b-fill${i}@example.com`);
    const users = await countIn(t.b, 'users', 'disabled_at is null');
    for (let i = users; i < 4; i += 1) await t.b.user({ email: `b-race-fill${i}@example.com` });
    const invite = async (tenant: Tenant, email: string) =>
      (await tenant.call<{ url: string }>(root(tenant), 'POST', '/invitations', { email })).body.url.split(
        '/invite/',
      )[1]!;
    const accept = (tenant: Tenant, secret: string) =>
      tenant.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { secret, displayName: 'Racer', password: PASSWORD, device: { name: 'Mac' } },
      });
    const first = await invite(t.b, 'racer1@example.com');
    const second = await invite(t.b, 'racer2@example.com');
    const results = await Promise.all([accept(t.b, first), accept(t.b, second)]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    expect(await countIn(t.b, 'users', 'disabled_at is null')).toBe(5);

    // A's seat check holds A's lock; an acceptance in B goes through meanwhile.
    await disable(t.b, 'racer1@example.com');
    await disable(t.b, 'racer2@example.com');
    const third = await invite(t.b, 'racer3@example.com');
    // The request runs outside A's unit (a unit inside another is refused), while A's holds the lock.
    let release!: () => void;
    const held = new Promise<void>((resolve) => (release = resolve));
    let locked!: () => void;
    const lockTaken = new Promise<void>((resolve) => (locked = resolve));
    const unit = t.a.tdb.transaction(async (tx) => {
      await t.h.ctx.license.assertSeatAvailable(tx);
      locked();
      await held;
    });
    await lockTaken;
    const res = await accept(t.b, third);
    release();
    await unit;
    expect(res.statusCode).toBe(201);
  });
});
