import { afterEach, beforeEach, expect, it } from 'vitest';
import type { TeamMember } from '@wirebench/engine';
import * as repo from '../../../src/teams/repo.js';
import { effectiveRole } from '../../../src/teams/roles.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/teams/:teamId/members (§3.2)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let member: SignedInUser;
  let carol: SignedInUser;
  let team: repo.TeamRow;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    member = await signedInUser(h, { email: 'member@example.com' });
    carol = await signedInUser(h, { email: 'carol@example.com' });
    team = await seedTeam(h, { name: 'T', admins: [admin], members: [member] });
  });
  afterEach(() => h.close());

  const path = (userId?: string) => `/teams/${team.id}/members${userId === undefined ? '' : `/${userId}`}`;

  it('any member lists the members; an outsider gets 404; a disabled user is listed and marked', async () => {
    expect((await call(h, member, 'GET', path())).status).toBe(200);
    expect((await call<{ code: string }>(h, carol, 'GET', path())).body.code).toBe('teams-team-not-found');
    await h.db.query('update users set disabled_at = now() where id = $1', [member.user.id]);
    const res = await call<TeamMember[]>(h, admin, 'GET', path());
    expect(res.body.map((m) => [m.email, m.role, m.disabled])).toEqual([
      ['admin@example.com', 'admin', false],
      ['member@example.com', 'member', true],
    ]);
  });

  it('a team admin adds an existing user by email; duplicates, unknown emails and members are refused', async () => {
    expect(await call(h, admin, 'POST', path(), { email: 'CAROL@example.com', role: 'member' })).toMatchObject({
      status: 201,
      body: { userId: carol.user.id, email: 'carol@example.com', role: 'member', disabled: false },
    });
    expect(await call(h, admin, 'POST', path(), { email: 'carol@example.com', role: 'admin' })).toMatchObject({
      status: 409,
      body: { code: 'teams-already-member' },
    });
    expect(await call(h, admin, 'POST', path(), { email: 'nobody@example.com', role: 'member' })).toMatchObject({
      status: 404,
      body: { code: 'teams-user-unknown', message: 'No user has this email. Invite them instead.' },
    });
    expect(
      (await call<{ code: string }>(h, member, 'POST', path(), { email: 'x@example.com', role: 'member' })).body.code,
    ).toBe('teams-forbidden');
  });

  it('promote, demote, and never the last admin', async () => {
    expect(await call(h, admin, 'PATCH', path(member.user.id), { role: 'admin' })).toMatchObject({
      status: 200,
      body: { role: 'admin' },
    });
    expect(await call(h, member, 'PATCH', path(admin.user.id), { role: 'member' })).toMatchObject({
      status: 200,
      body: { role: 'member' },
    });
    expect(await call(h, member, 'PATCH', path(member.user.id), { role: 'member' })).toMatchObject({
      status: 400,
      body: { code: 'teams-last-admin' },
    });
    expect((await call<{ code: string }>(h, member, 'PATCH', path(carol.user.id), { role: 'admin' })).body.code).toBe(
      'teams-member-not-found',
    );
  });

  it('two admins demoting each other at once: exactly one wins and the team keeps an admin', async () => {
    await repo.setMemberRole(h.db, team.id, member.user.id, 'admin');
    const results = await Promise.all([
      call(h, admin, 'PATCH', path(member.user.id), { role: 'member' }),
      call(h, member, 'PATCH', path(admin.user.id), { role: 'member' }),
    ]);
    // The loser is refused as the last admin, or, if the winner committed before the loser's
    // guard ran, as a member who may no longer change roles.
    expect(results.filter((r) => r.status === 200)).toHaveLength(1);
    expect(await repo.countAdmins(h.db, team.id)).toBe(1);
  });

  it('removal ends grants in the team; a member leaves; nobody removes the last admin', async () => {
    const workspaceId = await seedWorkspace(h, { team, name: 'W' });
    await repo.upsertGrant(h.db, { workspaceId, userId: member.user.id, role: 'editor', at: h.clock.now });
    expect((await call(h, admin, 'DELETE', path(member.user.id))).status).toBe(204);
    expect(await effectiveRole(h.db, member.user.id, workspaceId)).toEqual({ role: 'none' });
    expect((await repo.workspaceFacts(h.db, member.user.id, workspaceId))?.grant).toBeNull();
    await repo.insertMember(h.db, { teamId: team.id, userId: carol.user.id, role: 'member', at: h.clock.now });
    expect((await call<{ code: string }>(h, carol, 'DELETE', path(admin.user.id))).body.code).toBe('teams-forbidden');
    expect((await call(h, carol, 'DELETE', path(carol.user.id))).status).toBe(204);
    expect((await call<{ code: string }>(h, admin, 'DELETE', path(admin.user.id))).body.code).toBe('teams-last-admin');
    expect((await call<{ code: string }>(h, admin, 'DELETE', path(carol.user.id))).body.code).toBe(
      'teams-member-not-found',
    );
  });
});
