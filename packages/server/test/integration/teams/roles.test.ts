import { afterEach, beforeEach, expect, it } from 'vitest';
import { teamParamsSchema, teamWorkspaceParamsSchema } from '@wirebench/engine';
import type { ServerModule } from '../../../src/context.js';
import { newId } from '../../../src/identity/tokens.js';
import { jsonSchema } from '../../../src/schema.js';
import { teamsModule } from '../../../src/teams/module.js';
import * as repo from '../../../src/teams/repo.js';
import { effectiveRole, requireTeamRole, requireWorkspaceRole } from '../../../src/teams/roles.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace } from '../../helpers/teams.js';

/** What server-sync will do: guard a route by workspace role (§3.3), and one by team role. */
const probe: ServerModule = {
  name: 'server-sync',
  register: async (app, ctx) => {
    app.get(
      '/probe/:workspaceId',
      {
        preHandler: requireWorkspaceRole(ctx.db, 'editor'),
        schema: { params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' }) },
      },
      (request) => Promise.resolve(request.workspaceAccess),
    );
    app.get(
      '/probe-team/:teamId',
      {
        preHandler: requireTeamRole(ctx.db, 'admin'),
        schema: { params: jsonSchema(teamParamsSchema, { io: 'input' }) },
      },
      (request) => Promise.resolve(request.teamAccess),
    );
    await Promise.resolve();
  },
};

describeDb('requireWorkspaceRole and requireTeamRole (§3.3)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let member: SignedInUser;
  let editor: SignedInUser;
  let stranger: SignedInUser;
  let root: SignedInUser;
  let workspaceId: string;
  let teamId: string;
  beforeEach(async () => {
    h = await identityHarness({ modules: (clock) => [teamsModule({ now: () => clock.now }), probe] });
    admin = await signedInUser(h, { email: 'admin@example.com' });
    member = await signedInUser(h, { email: 'member@example.com' });
    editor = await signedInUser(h, { email: 'editor@example.com' });
    stranger = await signedInUser(h, { email: 'stranger@example.com' });
    root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const team = await seedTeam(h, { name: 'T', admins: [admin], members: [member, editor] });
    teamId = team.id;
    workspaceId = await seedWorkspace(h, { team, name: 'W' });
    await repo.upsertGrant(h.db, { workspaceId, userId: editor.user.id, role: 'editor', at: h.clock.now });
  });
  afterEach(() => h.close());

  it('a viewer is refused with 403, a stranger and an unknown id with 404, nobody with 401', async () => {
    expect(await call(h, member, 'GET', `/probe/${workspaceId}`)).toEqual({
      status: 403,
      body: { code: 'teams-forbidden', message: 'Your role does not allow this.' },
    });
    for (const [user, id] of [
      [stranger, workspaceId],
      [admin, newId()],
    ] as const) {
      const res = await call<{ code: string }>(h, user, 'GET', `/probe/${id}`);
      expect([res.status, res.body.code]).toEqual([404, 'teams-workspace-not-found']);
    }
    expect((await call<{ code: string }>(h, undefined, 'GET', `/probe/${workspaceId}`)).body.code).toBe(
      'identity-unauthenticated',
    );
  });

  it('editor and above pass and see their role and its source', async () => {
    expect((await call(h, editor, 'GET', `/probe/${workspaceId}`)).body).toEqual({
      workspaceId,
      role: 'editor',
      source: 'grant',
    });
    expect((await call(h, admin, 'GET', `/probe/${workspaceId}`)).body).toMatchObject({
      role: 'admin',
      source: 'team-admin',
    });
    expect((await call(h, root, 'GET', `/probe/${workspaceId}`)).body).toMatchObject({
      role: 'admin',
      source: 'server-admin',
    });
  });

  it('a malformed id is a 400 before any query', async () => {
    const res = await call<{ code: string }>(h, admin, 'GET', '/probe/not-a-ulid');
    expect([res.status, res.body.code]).toEqual([400, 'invalid-request']);
  });

  it('team guard: outsider 404, member 403, admin and server admin pass', async () => {
    expect((await call<{ code: string }>(h, stranger, 'GET', `/probe-team/${teamId}`)).body.code).toBe(
      'teams-team-not-found',
    );
    expect((await call<{ code: string }>(h, member, 'GET', `/probe-team/${teamId}`)).body.code).toBe('teams-forbidden');
    expect((await call(h, admin, 'GET', `/probe-team/${teamId}`)).body).toEqual({ teamId, role: 'admin' });
    expect((await call(h, root, 'GET', `/probe-team/${teamId}`)).body).toEqual({ teamId, role: 'admin' });
    expect((await call<{ code: string }>(h, root, 'GET', `/probe-team/${newId()}`)).body.code).toBe(
      'teams-team-not-found',
    );
  });

  it('a user in two teams has a different role in each; a disabled user has none', async () => {
    const other = await seedTeam(h, { name: 'U', members: [admin] });
    const theirs = await seedWorkspace(h, { team: other, name: 'W', defaultRole: 'editor' });
    expect(await effectiveRole(h.db, admin.user.id, workspaceId)).toEqual({ role: 'admin', source: 'team-admin' });
    expect(await effectiveRole(h.db, admin.user.id, theirs)).toEqual({ role: 'editor', source: 'default' });
    await h.db.query('update users set disabled_at = now() where id = $1', [admin.user.id]);
    expect(await effectiveRole(h.db, admin.user.id, workspaceId)).toEqual({ role: 'none' });
  });
});
