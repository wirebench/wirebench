import { afterEach, beforeEach, expect, it } from 'vitest';
import { isForeignKeyViolation, isUniqueViolation } from '../../../src/db/errors.js';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('teams repository (§4.1)', () => {
  let h: IdentityHarness;
  let alice: SignedInUser;
  let bob: SignedInUser;
  beforeEach(async () => {
    h = await teamsHarness();
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
  });
  afterEach(() => h.close());

  it('team names are unique regardless of case, under the index the routes map', async () => {
    await repo.insertTeam(h.db, { id: newId(), name: 'Payments QA', at: h.clock.now });
    const error: unknown = await repo
      .insertTeam(h.db, { id: newId(), name: 'payments qa', at: h.clock.now })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(error, 'teams_name_lower')).toBe(true);
  });

  it('members: insert is idempotent, admins are counted, and only the team’s grants go with a removal', async () => {
    const team = await seedTeam(h, { name: 'T', admins: [alice] });
    const add = (role: 'admin' | 'member') =>
      repo.insertMember(h.db, { teamId: team.id, userId: bob.user.id, role, at: h.clock.now });
    expect(await add('member')).toBe(true);
    expect(await add('admin')).toBe(false);
    expect(await repo.memberRole(h.db, team.id, bob.user.id)).toBe('member');
    expect(await repo.countAdmins(h.db, team.id)).toBe(1);
    expect((await repo.listMembers(h.db, team.id)).map((m) => [m.email, m.role, m.disabled])).toEqual([
      ['alice@example.com', 'admin', false],
      ['bob@example.com', 'member', false],
    ]);
    const other = await seedTeam(h, { name: 'Other', members: [bob] });
    const here = await seedWorkspace(h, { team, name: 'W' });
    const there = await seedWorkspace(h, { team: other, name: 'W' });
    await repo.upsertGrant(h.db, { workspaceId: here, userId: bob.user.id, role: 'editor', at: h.clock.now });
    await repo.upsertGrant(h.db, { workspaceId: there, userId: bob.user.id, role: 'editor', at: h.clock.now });
    await repo.deleteGrantsInTeam(h.db, team.id, bob.user.id);
    expect((await repo.workspaceFacts(h.db, bob.user.id, here))?.grant).toBeNull();
    expect((await repo.workspaceFacts(h.db, bob.user.id, there))?.grant).toBe('editor');
  });

  it('workspace names are unique per team regardless of case; ids are unique; a team with workspaces cannot go', async () => {
    const team = await seedTeam(h, { name: 'T' });
    const other = await seedTeam(h, { name: 'U' });
    const id = await seedWorkspace(h, { team, name: 'Integration' });
    await seedWorkspace(h, { team: other, name: 'integration' }); // another team: fine
    const sameName: unknown = await seedWorkspace(h, { team, name: 'INTEGRATION' }).catch((e: unknown) => e);
    expect(isUniqueViolation(sameName, 'workspaces_team_name_lower')).toBe(true);
    const sameId: unknown = await repo
      .insertWorkspace(h.db, {
        id,
        name: 'X',
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: h.clock.now,
      })
      .catch((e: unknown) => e);
    expect(isUniqueViolation(sameId, 'workspaces_pkey')).toBe(true);
    const inUse: unknown = await repo.deleteTeam(h.db, team.id).catch((e: unknown) => e);
    expect(isForeignKeyViolation(inUse)).toBe(true);
  });

  it('a team deleted between an access guard and the write surfaces the exact FK the routes map to teams-team-not-found', async () => {
    // Stands in for the race a concurrent team delete creates: the guard that checked the team
    // exists has already passed, and the insert that follows is the one that now hits the gone
    // row. `isForeignKeyViolation(error, <constraint>)` is what `workspaces.ts` and `members.ts`
    // use to turn this into `teamNotFound()` instead of a bare 500.
    const team = await seedTeam(h, { name: 'Doomed' });
    await repo.deleteTeam(h.db, team.id); // no workspaces yet, so this one succeeds
    const workspaceError: unknown = await repo
      .insertWorkspace(h.db, {
        id: newId(),
        name: 'Orphaned',
        teamId: team.id,
        defaultRole: 'viewer',
        createdBy: null,
        at: h.clock.now,
      })
      .catch((e: unknown) => e);
    expect(isForeignKeyViolation(workspaceError, 'workspaces_team_id_fkey')).toBe(true);
    expect(isForeignKeyViolation(workspaceError, 'some-other-constraint')).toBe(false);

    const memberError: unknown = await repo
      .insertMember(h.db, { teamId: team.id, userId: alice.user.id, role: 'member', at: h.clock.now })
      .catch((e: unknown) => e);
    expect(isForeignKeyViolation(memberError, 'team_members_team_id_fkey')).toBe(true);
  });

  it('visibleWorkspaces: members see their teams’ workspaces, server admins see every one', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const team = await seedTeam(h, { name: 'T', members: [alice] });
    const other = await seedTeam(h, { name: 'U' });
    await seedWorkspace(h, { team, name: 'Mine' });
    await seedWorkspace(h, { team: other, name: 'Theirs' });
    expect((await repo.visibleWorkspaces(h.db, alice.user.id, false)).map((w) => [w.name, w.teamRole])).toEqual([
      ['Mine', 'member'],
    ]);
    expect((await repo.visibleWorkspaces(h.db, root.user.id, true)).map((w) => w.name)).toEqual(['Mine', 'Theirs']);
    expect(await repo.visibleWorkspaces(h.db, bob.user.id, false)).toEqual([]);
  });

  it('accessRows lists every team member with their grant; updateWorkspace patches only what it is given', async () => {
    const team = await seedTeam(h, { name: 'T', admins: [bob], members: [alice] });
    const id = await seedWorkspace(h, { team, name: 'W', defaultRole: 'none' });
    await repo.upsertGrant(h.db, { workspaceId: id, userId: alice.user.id, role: 'viewer', at: h.clock.now });
    await repo.upsertGrant(h.db, { workspaceId: id, userId: alice.user.id, role: 'editor', at: h.clock.now });
    expect((await repo.accessRows(h.db, id)).map((r) => [r.email, r.teamRole, r.grant, r.defaultRole])).toEqual([
      ['alice@example.com', 'member', 'editor', 'none'],
      ['bob@example.com', 'admin', null, 'none'],
    ]);
    await repo.updateWorkspace(h.db, id, { defaultRole: 'editor' });
    expect(await repo.workspaceById(h.db, id)).toMatchObject({ name: 'W', defaultRole: 'editor', teamName: 'T' });
    expect(await repo.isTeamMemberOfWorkspace(h.db, id, alice.user.id)).toBe(true);
    const stranger = await signedInUser(h, { email: 'x@example.com' });
    expect(await repo.isTeamMemberOfWorkspace(h.db, id, stranger.user.id)).toBe(false);
    expect(await repo.workspaceFacts(h.db, alice.user.id, newId())).toBeUndefined();
  });

  it('lockTeam answers whether the team exists', async () => {
    const team = await seedTeam(h, { name: 'T' });
    expect(await h.db.transaction((tx) => repo.lockTeam(tx, team.id))).toBe(true);
    expect(await h.db.transaction((tx) => repo.lockTeam(tx, newId()))).toBe(false);
  });

  it('workspaceIdsOfTeam lists exactly one team’s current workspace ids, and none for an empty or unknown team', async () => {
    const team = await seedTeam(h, { name: 'T' });
    const other = await seedTeam(h, { name: 'U' });
    const empty = await seedTeam(h, { name: 'V' });
    const a = await seedWorkspace(h, { team, name: 'A' });
    const b = await seedWorkspace(h, { team, name: 'B' });
    await seedWorkspace(h, { team: other, name: 'A' });
    expect([...(await repo.workspaceIdsOfTeam(h.db, team.id))].sort()).toEqual([a, b].sort());
    expect(await repo.workspaceIdsOfTeam(h.db, empty.id)).toEqual([]);
    expect(await repo.workspaceIdsOfTeam(h.db, newId())).toEqual([]);
    await repo.deleteWorkspace(h.db, a);
    expect(await repo.workspaceIdsOfTeam(h.db, team.id)).toEqual([b]);
  });
});
