import { afterEach, beforeEach, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import type { AuditInput } from '../../../src/context.js';
import { ssoModule } from '../../../src/sso/module.js';
import * as repo from '../../../src/sso/repo.js';
import * as teamsRepo from '../../../src/teams/repo.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { seedTeam } from '../../helpers/teams.js';

const PATCH_OP = 'urn:ietf:params:scim:api:messages:2.0:PatchOp';

describeDb('group → team links and provisioned memberships (saml-scim spec §3.6)', () => {
  const keys = testKeys();
  let h: IdentityHarness;
  let admin: SignedInUser;
  let bearer: string;
  let events: AuditInput[];
  let access: { teamId: string; userId: string }[];
  let teamId: string;
  let ada: SignedInUser;
  let bob: SignedInUser;

  beforeEach(async () => {
    h = await licensingHarness(keys, {
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    await h.app.inject({
      method: 'PUT',
      url: '/api/v1/license',
      headers: admin.headers,
      payload: { license: license(keys, { edition: 'enterprise' }) },
    });
    bearer = (
      await h.app.inject({
        method: 'POST',
        url: '/api/v1/scim-tokens',
        headers: admin.headers,
        payload: { name: 'IdP' },
      })
    ).json<{ token: string }>().token;
    teamId = (await seedTeam(h, { name: 'Payments', admins: [admin] })).id;
    ada = await signedInUser(h, { email: 'ada@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
    events = recordingAudit(h.hooks);
    access = [];
    h.hooks.accessChanged.push((event) => {
      if (event.teamId !== undefined && event.userId !== undefined)
        access.push({ teamId: event.teamId, userId: event.userId });
    });
  });
  afterEach(async () => {
    await h.close();
  });

  const scim = (method: 'POST' | 'PATCH' | 'DELETE', path: string, payload?: object) =>
    h.app.inject({
      method,
      url: `/scim/v2${path}`,
      headers: { authorization: `Bearer ${bearer}`, 'content-type': 'application/scim+json' },
      ...(payload !== undefined ? { payload: JSON.stringify(payload) } : {}),
    });
  const group = async (displayName: string, members: SignedInUser[]) =>
    (await scim('POST', '/Groups', { displayName, members: members.map((m) => ({ value: m.user.id })) })).json<{
      id: string;
    }>().id;
  const link = (groupId: string, team = teamId) =>
    h.app.inject({
      method: 'PUT',
      url: `/api/v1/scim-groups/${groupId}/team`,
      headers: admin.headers,
      payload: { teamId: team },
    });
  const unlink = (groupId: string) =>
    h.app.inject({ method: 'DELETE', url: `/api/v1/scim-groups/${groupId}/team`, headers: admin.headers });
  const members = async () => (await teamsRepo.listMembers(h.tdb, teamId)).map((m) => m.email).sort();
  const addMember = (groupId: string, user: SignedInUser) =>
    scim('PATCH', `/Groups/${groupId}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: 'add', path: 'members', value: [{ value: user.user.id }] }],
    });
  const removeMember = (groupId: string, user: SignedInUser) =>
    scim('PATCH', `/Groups/${groupId}`, {
      schemas: [PATCH_OP],
      Operations: [{ op: 'remove', path: `members[value eq "${user.user.id}"]` }],
    });

  it('linking adds enabled members as member with provisioned rows; existing and disabled people are left alone', async () => {
    const dis = await signedInUser(h, { email: 'dis@example.com', disabled: true });
    await teamsRepo.insertMember(h.tdb, { teamId, userId: bob.user.id, role: 'member', at: h.clock.now });
    const groupId = await group('Payments eng', [ada, bob, dis]);
    const res = await link(groupId);
    expect(res.statusCode, res.body).toBe(200);
    expect(res.json()).toMatchObject({ memberCount: 3, team: { id: teamId, name: 'Payments' } });
    expect(await members()).toEqual(['ada@example.com', 'bob@example.com', 'root@example.com']);
    expect(await repo.countProvisioned(h.db, teamId, ada.user.id)).toBe(1);
    expect(await repo.countProvisioned(h.db, teamId, bob.user.id)).toBe(0);
    expect(access).toEqual([{ teamId, userId: ada.user.id }]);
    const added = events.filter((e) => e.action === 'team.member_added');
    expect(added).toHaveLength(1);
    expect(added[0]!.details).toMatchObject({ via: 'scim', role: 'member' });
    expect(events.map((e) => e.action)).toContain('scim.group_linked');
  });

  it('a linked group gaining a member adds them; losing one removes them and their grants', async () => {
    const groupId = await group('Payments eng', []);
    await link(groupId);
    await addMember(groupId, ada);
    expect(await members()).toContain('ada@example.com');
    await removeMember(groupId, ada);
    expect(await members()).not.toContain('ada@example.com');
    expect(events.filter((e) => e.action === 'team.member_removed')[0]!.details).toMatchObject({ via: 'scim' });
  });

  it('two groups linked to one team: losing one group keeps the membership', async () => {
    const one = await group('One', [ada]);
    const two = await group('Two', [ada]);
    await link(one);
    await link(two);
    expect(await repo.countProvisioned(h.db, teamId, ada.user.id)).toBe(2);
    await removeMember(one, ada);
    expect(await members()).toContain('ada@example.com');
    await removeMember(two, ada);
    expect(await members()).not.toContain('ada@example.com');
  });

  it('someone promoted to team admin by hand is never removed by SCIM', async () => {
    const groupId = await group('Payments eng', [ada]);
    await link(groupId);
    await teamsRepo.setMemberRole(h.tdb, teamId, ada.user.id, 'admin');
    await removeMember(groupId, ada);
    expect(await members()).toContain('ada@example.com');
  });

  it('removing a provisioned member by hand drops their rows', async () => {
    const groupId = await group('Payments eng', [ada]);
    await link(groupId);
    await teamsRepo.deleteMember(h.tdb, teamId, ada.user.id);
    expect(await repo.countProvisioned(h.db, teamId, ada.user.id)).toBe(0);
  });

  it('unlinking or deleting the group removes the SCIM-added members and keeps the hand-added ones', async () => {
    await teamsRepo.insertMember(h.tdb, { teamId, userId: bob.user.id, role: 'member', at: h.clock.now });
    const groupId = await group('Payments eng', [ada, bob]);
    await link(groupId);
    expect((await unlink(groupId)).json()).toMatchObject({ team: null });
    expect(await members()).toEqual(['bob@example.com', 'root@example.com']);
    expect(events.map((e) => e.action)).toContain('scim.group_unlinked');

    await link(groupId);
    expect(await members()).toContain('ada@example.com');
    expect((await scim('DELETE', `/Groups/${groupId}`)).statusCode).toBe(204);
    expect(await members()).toEqual(['bob@example.com', 'root@example.com']);
  });

  it('deleting the team clears the link', async () => {
    const groupId = await group('Payments eng', [ada]);
    await link(groupId);
    await teamsRepo.deleteTeam(h.tdb, teamId);
    expect((await repo.scimGroupById(h.db, groupId))!.teamId).toBeNull();
  });

  it('the API is admin-only, feature-gated, and refuses an unknown team or group', async () => {
    const groupId = await group('Payments eng', []);
    expect((await link(groupId, '01J9ZK3V8Q0000000000000099')).statusCode).toBe(404);
    expect((await link('01J9ZK3V8Q0000000000000098')).json()).toMatchObject({ code: 'sso-scim-group-not-found' });
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/scim-groups', headers: ada.headers });
    expect(list.statusCode).toBe(403);
    const ok = await h.app.inject({ method: 'GET', url: '/api/v1/scim-groups', headers: admin.headers });
    expect(ok.json()).toEqual([{ id: groupId, displayName: 'Payments eng', memberCount: 0, team: null }]);
    await h.app.inject({ method: 'DELETE', url: '/api/v1/license', headers: admin.headers });
    const gated = await h.app.inject({ method: 'GET', url: '/api/v1/scim-groups', headers: admin.headers });
    expect(gated.json()).toMatchObject({ code: 'licensing-feature-required' });
  });
});
