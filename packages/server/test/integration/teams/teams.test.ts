import { afterEach, beforeEach, expect, it } from 'vitest';
import type { Team } from '@wirebench/engine';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/teams (§3.2)', () => {
  let h: IdentityHarness;
  let root: SignedInUser;
  let alice: SignedInUser;
  let bob: SignedInUser;
  beforeEach(async () => {
    h = await teamsHarness();
    root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
  });
  afterEach(() => h.close());

  it('a server admin creates a team with a trimmed name and becomes its admin', async () => {
    const res = await call<Team>(h, root, 'POST', '/teams', { name: '  Payments QA ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ name: 'Payments QA', myRole: 'admin' });
    expect(res.body.id).toMatch(/^[0-9A-Z]{26}$/);
    expect(await repo.memberRole(h.db, res.body.id, root.user.id)).toBe('admin');
  });

  it('refuses a non-admin, a duplicate name in any case, a blank name and a long one', async () => {
    expect((await call<{ code: string }>(h, alice, 'POST', '/teams', { name: 'X' })).body.code).toBe(
      'identity-forbidden',
    );
    await call(h, root, 'POST', '/teams', { name: 'Payments QA' });
    expect(await call(h, root, 'POST', '/teams', { name: 'payments qa' })).toMatchObject({
      status: 409,
      body: { code: 'teams-name-taken' },
    });
    expect(await call(h, root, 'POST', '/teams', { name: '   ' })).toMatchObject({
      status: 400,
      body: { code: 'teams-name-invalid' },
    });
    expect(await call(h, root, 'POST', '/teams', { name: 'x'.repeat(81) })).toMatchObject({
      status: 400,
      body: { code: 'invalid-request' },
    });
  });

  it('GET /teams: members see their teams with their role, a server admin sees every team as admin', async () => {
    const alpha = await seedTeam(h, { name: 'Alpha', admins: [alice], members: [bob] });
    await seedTeam(h, { name: 'beta', members: [alice] });
    await seedTeam(h, { name: 'Gamma' });
    expect((await call<Team[]>(h, alice, 'GET', '/teams')).body.map((t) => [t.name, t.myRole])).toEqual([
      ['Alpha', 'admin'],
      ['beta', 'member'],
    ]);
    expect((await call<Team[]>(h, bob, 'GET', '/teams')).body.map((t) => t.id)).toEqual([alpha.id]);
    expect((await call<Team[]>(h, root, 'GET', '/teams')).body.map((t) => [t.name, t.myRole])).toEqual([
      ['Alpha', 'admin'],
      ['beta', 'admin'],
      ['Gamma', 'admin'],
    ]);
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect((await call(h, stranger, 'GET', '/teams')).body).toEqual([]);
    expect((await call(h, undefined, 'GET', '/teams')).status).toBe(401);
  });

  it('a team admin renames; a member gets 403, an outsider 404, a clash 409, a bad id 400', async () => {
    const team = await seedTeam(h, { name: 'Alpha', admins: [alice], members: [bob] });
    await seedTeam(h, { name: 'Beta' });
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect(await call(h, alice, 'PATCH', `/teams/${team.id}`, { name: 'Alpha QA' })).toMatchObject({
      status: 200,
      body: { name: 'Alpha QA', myRole: 'admin' },
    });
    expect((await call<{ code: string }>(h, bob, 'PATCH', `/teams/${team.id}`, { name: 'X' })).body.code).toBe(
      'teams-forbidden',
    );
    expect((await call<{ code: string }>(h, stranger, 'PATCH', `/teams/${team.id}`, { name: 'X' })).body.code).toBe(
      'teams-team-not-found',
    );
    expect((await call<{ code: string }>(h, alice, 'PATCH', `/teams/${team.id}`, { name: 'BETA' })).body.code).toBe(
      'teams-name-taken',
    );
    expect((await call(h, alice, 'PATCH', '/teams/nope', { name: 'X' })).status).toBe(400);
  });

  it('only a server admin deletes a team, and only an empty one', async () => {
    const team = await seedTeam(h, { name: 'Alpha', admins: [alice] });
    const workspaceId = await seedWorkspace(h, { team, name: 'W' });
    expect((await call<{ code: string }>(h, alice, 'DELETE', `/teams/${team.id}`)).body.code).toBe(
      'identity-forbidden',
    );
    expect(await call(h, root, 'DELETE', `/teams/${team.id}`)).toMatchObject({
      status: 409,
      body: { code: 'teams-not-empty' },
    });
    await repo.deleteWorkspace(h.db, workspaceId);
    expect((await call(h, root, 'DELETE', `/teams/${team.id}`)).status).toBe(204);
    expect(await repo.teamById(h.db, team.id)).toBeUndefined();
    expect(await repo.memberRole(h.db, team.id, alice.user.id)).toBeUndefined();
    expect((await call<{ code: string }>(h, root, 'DELETE', `/teams/${team.id}`)).body.code).toBe(
      'teams-team-not-found',
    );
  });
});
