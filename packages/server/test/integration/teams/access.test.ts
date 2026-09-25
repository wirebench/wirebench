import { afterEach, beforeEach, expect, it } from 'vitest';
import type { AccessEntry, TeamWorkspace } from '@wirebench/engine';
import type * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/workspaces/:workspaceId/access (§3.2)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let alice: SignedInUser;
  let bob: SignedInUser;
  let team: repo.TeamRow;
  let id: string;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
    team = await seedTeam(h, { name: 'T', admins: [admin], members: [alice, bob] });
    id = await seedWorkspace(h, { team, name: 'W' });
  });
  afterEach(() => h.close());

  const access = async () =>
    (await call<AccessEntry[]>(h, admin, 'GET', `/workspaces/${id}/access`)).body.map((e) => [
      e.email,
      e.effectiveRole,
      e.source ?? null,
      e.grant ?? null,
    ]);
  const myRole = async (as: SignedInUser) =>
    (await call<TeamWorkspace[]>(h, as, 'GET', '/workspaces')).body.find((w) => w.id === id)?.myRole ?? 'none';

  it('lists every team member with the role they have and why', async () => {
    expect(await access()).toEqual([
      ['admin@example.com', 'admin', 'team-admin', null],
      ['alice@example.com', 'viewer', 'default', null],
      ['bob@example.com', 'viewer', 'default', null],
    ]);
    expect((await call<{ code: string }>(h, alice, 'GET', `/workspaces/${id}/access`)).body.code).toBe(
      'teams-forbidden',
    );
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect((await call<{ code: string }>(h, stranger, 'GET', `/workspaces/${id}/access`)).body.code).toBe(
      'teams-workspace-not-found',
    );
  });

  it('a grant, its removal and a default-role change each take effect immediately', async () => {
    expect((await call(h, admin, 'PUT', `/workspaces/${id}/access/${bob.user.id}`, { role: 'editor' })).status).toBe(
      204,
    );
    expect(await myRole(bob)).toBe('editor');
    expect(await access()).toContainEqual(['bob@example.com', 'editor', 'grant', 'editor']);
    expect((await call(h, admin, 'PATCH', `/workspaces/${id}`, { defaultRole: 'none' })).status).toBe(200);
    expect(await myRole(alice)).toBe('none');
    expect(await myRole(bob)).toBe('editor');
    expect((await call(h, admin, 'DELETE', `/workspaces/${id}/access/${bob.user.id}`)).status).toBe(204);
    expect(await myRole(bob)).toBe('none');
    expect(await access()).toContainEqual(['bob@example.com', 'none', null, null]);
  });

  it('a grant can lower a member below the default; a team admin stays admin whatever the grant', async () => {
    await call(h, admin, 'PATCH', `/workspaces/${id}`, { defaultRole: 'editor' });
    await call(h, admin, 'PUT', `/workspaces/${id}/access/${alice.user.id}`, { role: 'viewer' });
    await call(h, admin, 'PUT', `/workspaces/${id}/access/${admin.user.id}`, { role: 'viewer' });
    expect(await access()).toEqual([
      ['admin@example.com', 'admin', 'team-admin', 'viewer'],
      ['alice@example.com', 'viewer', 'grant', 'viewer'],
      ['bob@example.com', 'editor', 'default', null],
    ]);
  });

  it('refuses a grant for someone off the team and a role outside the list', async () => {
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect(
      await call(h, admin, 'PUT', `/workspaces/${id}/access/${stranger.user.id}`, { role: 'viewer' }),
    ).toMatchObject({
      status: 400,
      body: { code: 'teams-not-a-member' },
    });
    expect(await call(h, admin, 'PUT', `/workspaces/${id}/access/${bob.user.id}`, { role: 'owner' })).toMatchObject({
      status: 400,
      body: { code: 'invalid-request' },
    });
  });
});
