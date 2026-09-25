import { readdirSync } from 'node:fs';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it } from 'vitest';
import { GitCli } from '@wirebench/engine';
import type { TeamWorkspace } from '@wirebench/engine';
import { newId } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/teams/repo.js';
import { describeDb } from '../../helpers/database.js';
import { gitLocation } from '../../helpers/git.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { call, seedTeam, seedWorkspace, teamsHarness } from '../../helpers/teams.js';

describeDb('/workspaces (§3.2, §3.6, §3.7)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let alice: SignedInUser;
  let bob: SignedInUser;
  let stranger: SignedInUser;
  let team: repo.TeamRow;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    alice = await signedInUser(h, { email: 'alice@example.com' });
    bob = await signedInUser(h, { email: 'bob@example.com' });
    stranger = await signedInUser(h, { email: 'stranger@example.com' });
    team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [alice, bob] });
  });
  afterEach(() => h.close());

  const create = (as: SignedInUser, payload: object) =>
    call<TeamWorkspace & { code?: string }>(h, as, 'POST', `/teams/${team.id}/workspaces`, payload);
  const list = async (as: SignedInUser) =>
    (await call<TeamWorkspace[]>(h, as, 'GET', '/workspaces')).body.map((w) => [w.name, w.myRole, w.source]);

  it('a member creates one: the row, the repository, the creator as admin, the others at the default role', async () => {
    const res = await create(alice, { name: ' Integration ' });
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({
      name: 'Integration',
      teamId: team.id,
      teamName: 'Payments QA',
      defaultRole: 'viewer',
      myRole: 'admin',
      source: 'grant',
    });
    expect(await h.repos.exists(res.body.id)).toBe(true);
    expect(await list(bob)).toEqual([['Integration', 'viewer', 'default']]);
    expect(await list(admin)).toEqual([['Integration', 'admin', 'team-admin']]);
    expect(await list(stranger)).toEqual([]);
    expect((await create(stranger, { name: 'X' })).body.code).toBe('teams-team-not-found');
  });

  it('takes the app’s id; a taken id, an existing repository and a clashing name are 409s with nothing left behind', async () => {
    const id = newId();
    expect((await create(alice, { id, name: 'A' })).body.id).toBe(id);
    expect(await create(bob, { id, name: 'B' })).toMatchObject({
      status: 409,
      body: { code: 'teams-workspace-exists' },
    });
    expect(await create(bob, { name: 'a' })).toMatchObject({
      status: 409,
      body: { code: 'teams-workspace-name-taken' },
    });
    const orphan = newId();
    await h.repos.withLock(orphan, () => h.repos.create(orphan));
    expect(await create(bob, { id: orphan, name: 'C' })).toMatchObject({
      status: 409,
      body: { code: 'teams-workspace-exists' },
    });
    expect(await repo.workspaceById(h.db, orphan)).toBeUndefined();
  });

  it('a failing repository build leaves no row and no repository (§11)', async () => {
    // `run` rejects for every git invocation, so `RepoStore.create`'s first `git init` throws a
    // plain `git-failed` — not `server-repo-exists` — and `conflictOr` must let it through as a
    // 5xx rather than swallowing it.
    const failingGit = new GitCli(gitLocation!, {
      hooksDir: h.dataDir,
      run: () => Promise.reject(new Error('simulated git failure')),
    });
    const broken = await teamsHarness({ git: failingGit });
    try {
      const owner = await signedInUser(broken, { email: 'owner@example.com' });
      const brokenTeam = await seedTeam(broken, { name: 'Broken', admins: [owner] });
      const id = newId();
      const res = await call<{ code?: string }>(broken, owner, 'POST', `/teams/${brokenTeam.id}/workspaces`, {
        id,
        name: 'Boom',
      });
      expect(res.status).toBeGreaterThanOrEqual(500);
      expect(await repo.workspaceById(broken.db, id)).toBeUndefined();
      expect(await broken.repos.exists(id)).toBe(false);
    } finally {
      await broken.close();
    }
  });

  it('default none hides it from members without a grant, as a 404', async () => {
    const res = await create(alice, { name: 'Secret', defaultRole: 'none' });
    expect(await list(bob)).toEqual([]);
    expect((await call<{ code: string }>(h, bob, 'GET', `/workspaces/${res.body.id}`)).body.code).toBe(
      'teams-workspace-not-found',
    );
    expect((await call<TeamWorkspace>(h, alice, 'GET', `/workspaces/${res.body.id}`)).body.myRole).toBe('admin');
  });

  it('a workspace admin renames it and changes the default role; a viewer cannot', async () => {
    const { id } = (await create(alice, { name: 'W' })).body;
    await create(alice, { name: 'Other' });
    expect(await call(h, alice, 'PATCH', `/workspaces/${id}`, { defaultRole: 'editor', name: 'W2' })).toMatchObject({
      status: 200,
      body: { name: 'W2', defaultRole: 'editor', myRole: 'admin' },
    });
    expect(await list(bob)).toEqual([
      ['Other', 'viewer', 'default'],
      ['W2', 'editor', 'default'],
    ]);
    expect((await call<{ code: string }>(h, bob, 'PATCH', `/workspaces/${id}`, { name: 'X' })).body.code).toBe(
      'teams-forbidden',
    );
    expect((await call<{ code: string }>(h, alice, 'PATCH', `/workspaces/${id}`, { name: 'other' })).body.code).toBe(
      'teams-workspace-name-taken',
    );
  });

  it('delete moves the repository away, and still answers 204 when the directory is already gone', async () => {
    const { id } = (await create(alice, { name: 'W' })).body;
    expect((await call<{ code: string }>(h, bob, 'DELETE', `/workspaces/${id}`)).body.code).toBe('teams-forbidden');
    expect((await call(h, alice, 'DELETE', `/workspaces/${id}`)).status).toBe(204);
    expect(await repo.workspaceById(h.db, id)).toBeUndefined();
    expect(await h.repos.exists(id)).toBe(false);
    expect(readdirSync(join(h.dataDir, 'tmp')).some((name) => name.startsWith(`removed-${id}-`))).toBe(true);
    const bare = await seedWorkspace(h, { team, name: 'No repository' });
    expect((await call(h, admin, 'DELETE', `/workspaces/${bare}`)).status).toBe(204);
    expect((await call(h, admin, 'GET', `/workspaces/${bare}`)).status).toBe(404);
  });

  it('a server admin sees every workspace as admin, source server-admin, and gets no grant for creating one', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const res = await create(root, { name: 'By root' });
    expect(res.body).toMatchObject({ myRole: 'admin', source: 'server-admin' });
    expect((await repo.workspaceFacts(h.db, root.user.id, res.body.id))?.grant).toBeNull();
    expect(await list(root)).toEqual([['By root', 'admin', 'server-admin']]);
  });
});
