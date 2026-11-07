import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Team, TeamInvitation, TeamInvitationCreated } from '@wirebench/engine';
import * as identityRepo from '../../../src/identity/repo.js';
import { pkceChallenge } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/teams/repo.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call, seedTeam, teamsHarness } from '../../helpers/teams.js';

const PASSWORD = 'correct horse battery';
const secretOf = (url: string): string => url.slice(url.lastIndexOf('/') + 1);

describeDb('team invitations (§3.2, §3.4)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  let member: SignedInUser;
  let team: repo.TeamRow;
  beforeEach(async () => {
    h = await teamsHarness();
    admin = await signedInUser(h, { email: 'admin@example.com' });
    member = await signedInUser(h, { email: 'member@example.com' });
    team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [member] });
  });
  afterEach(() => h.close());

  const invite = (email: string, role: 'member' | 'admin' = 'member', as = admin) =>
    call<TeamInvitationCreated & { code?: string; message?: string }>(h, as, 'POST', `/teams/${team.id}/invitations`, {
      email,
      role,
    });
  const accept = (url: string, name: string) =>
    call<{ token: string; user: { id: string } }>(h, undefined, 'POST', '/invitations/accept', {
      secret: secretOf(url),
      displayName: name,
      password: PASSWORD,
      device: { name: 'laptop' },
    });

  it('a team admin invites; the link is shown once; the list and identity both know it, never as server admin', async () => {
    const res = await invite('Bob@example.com');
    expect(res.status).toBe(201);
    expect(res.body).toMatchObject({ email: 'Bob@example.com', role: 'member' });
    expect(res.body.url).toMatch(/^https:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    const list = await call<TeamInvitation[]>(h, admin, 'GET', `/teams/${team.id}/invitations`);
    expect(list.body).toEqual([
      expect.objectContaining({ id: res.body.id, email: 'Bob@example.com', role: 'member', createdBy: admin.user.id }),
    ]);
    expect(JSON.stringify(list.body)).not.toContain(secretOf(res.body.url));
    expect((await identityRepo.invitationById(h.tdb, res.body.id))?.serverAdmin).toBe(false);
  });

  it('refuses an existing user with the hint, a member with 403 and an outsider with 404', async () => {
    expect(await invite('MEMBER@example.com')).toMatchObject({
      status: 409,
      body: {
        code: 'identity-user-exists',
        message: 'A user with this email already exists. Add them as a member instead.',
      },
    });
    expect((await invite('x@example.com', 'member', member)).body.code).toBe('teams-forbidden');
    const stranger = await signedInUser(h, { email: 'stranger@example.com' });
    expect((await invite('x@example.com', 'member', stranger)).body.code).toBe('teams-team-not-found');
  });

  it('accepting puts the new user on the team with the invited role, visible on their very first request', async () => {
    const { url } = (await invite('bob@example.com', 'admin')).body;
    const accepted = await accept(url, 'Bob');
    expect(accepted.status).toBe(201);
    const teams = await h.app.inject({
      method: 'GET',
      url: '/api/v1/teams',
      headers: { authorization: `Bearer ${accepted.body.token}` },
    });
    expect(teams.json<Team[]>().map((t) => [t.id, t.myRole])).toEqual([[team.id, 'admin']]);
    expect((await call<TeamInvitation[]>(h, admin, 'GET', `/teams/${team.id}/invitations`)).body).toEqual([]);
  });

  it('a plain server invitation adds no membership; a team deleted before acceptance leaves the user teamless', async () => {
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const plain = await call<{ url: string }>(h, root, 'POST', '/invitations', { email: 'carol@example.com' });
    const carol = await accept(plain.body.url, 'Carol');
    expect(await repo.teamsOfUser(h.tdb, carol.body.user.id)).toEqual([]);
    const { url } = (await invite('dan@example.com')).body;
    await repo.deleteTeam(h.tdb, team.id);
    const dan = await accept(url, 'Dan');
    expect(dan.status).toBe(201);
    expect(await repo.teamsOfUser(h.tdb, dan.body.user.id)).toEqual([]);
  });

  it('revoke: only this team’s open invitations, and only once', async () => {
    const { id, url } = (await invite('bob@example.com')).body;
    const other = await seedTeam(h, { name: 'Other', admins: [member] });
    expect((await call<{ code: string }>(h, member, 'DELETE', `/teams/${other.id}/invitations/${id}`)).body.code).toBe(
      'teams-invitation-not-found',
    );
    expect((await call(h, admin, 'DELETE', `/teams/${team.id}/invitations/${id}`)).status).toBe(204);
    expect((await call<{ code: string }>(h, admin, 'DELETE', `/teams/${team.id}/invitations/${id}`)).body.code).toBe(
      'teams-invitation-not-found',
    );
    expect((await accept(url, 'Bob')).status).toBe(404);
  });

  describe('renew', () => {
    type Renewed = TeamInvitationCreated & { code?: string; message?: string };
    const renew = (id: string, as = admin, teamId = team.id) =>
      call<Renewed>(h, as, 'POST', `/teams/${teamId}/invitations/${id}/renew`);
    const lookup = (url: string) =>
      call<{ code?: string }>(h, undefined, 'GET', `/invitations/lookup?secret=${secretOf(url)}`);

    it('a team admin renews: a new link, same email and role, the old link refused', async () => {
      const first = (await invite('bob@example.com', 'admin')).body;
      const res = await renew(first.id);
      expect(res.status).toBe(201);
      expect(res.body).toMatchObject({ email: 'bob@example.com', role: 'admin' });
      expect(res.body.id).not.toBe(first.id);
      expect(res.body.url).toMatch(/^https:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}$/);
      expect(res.body.url).not.toBe(first.url);
      expect(await lookup(first.url)).toMatchObject({ status: 404, body: { code: 'identity-invitation-invalid' } });
      expect((await lookup(res.body.url)).status).toBe(200);
      const list = await call<TeamInvitation[]>(h, admin, 'GET', `/teams/${team.id}/invitations`);
      expect(list.body.map((row) => [row.id, row.email, row.role])).toEqual([
        [res.body.id, 'bob@example.com', 'admin'],
      ]);
    });

    it('refuses a member with 403 and an outsider with 404', async () => {
      const { id } = (await invite('bob@example.com')).body;
      expect(await renew(id, member)).toMatchObject({ status: 403, body: { code: 'teams-forbidden' } });
      const stranger = await signedInUser(h, { email: 'stranger@example.com' });
      expect(await renew(id, stranger)).toMatchObject({ status: 404, body: { code: 'teams-team-not-found' } });
    });

    it('another team’s invitation, a revoked one and an accepted one are 404', async () => {
      const other = await seedTeam(h, { name: 'Other', admins: [admin] });
      const elsewhere = await call<TeamInvitationCreated>(h, admin, 'POST', `/teams/${other.id}/invitations`, {
        email: 'carol@example.com',
        role: 'member',
      });
      expect((await renew(elsewhere.body.id)).body.code).toBe('teams-invitation-not-found');
      const revoked = (await invite('dan@example.com')).body;
      expect((await call(h, admin, 'DELETE', `/teams/${team.id}/invitations/${revoked.id}`)).status).toBe(204);
      expect((await renew(revoked.id)).body.code).toBe('teams-invitation-not-found');
      const accepted = (await invite('erin@example.com')).body;
      expect((await accept(accepted.url, 'Erin')).status).toBe(201);
      expect(await renew(accepted.id)).toMatchObject({ status: 404, body: { code: 'teams-invitation-not-found' } });
    });

    it('an email that became an account since is 409 with the hint, and the old invitation stays open', async () => {
      const first = (await invite('bob@example.com')).body;
      await signedInUser(h, { email: 'Bob@example.com' });
      expect(await renew(first.id)).toMatchObject({
        status: 409,
        body: {
          code: 'identity-user-exists',
          message: 'A user with this email already exists. Add them as a member instead.',
        },
      });
      expect((await lookup(first.url)).status).toBe(200);
      const row = await identityRepo.invitationById(h.tdb, first.id);
      expect(row?.revokedAt).toBeNull();
    });

    it('is one transaction: a seat refusal leaves the old invitation open', async () => {
      // Community's five enabled accounts: the invitation is made at two, then three more fill every seat.
      await h.close();
      h = await licensingHarness(testKeys());
      admin = await signedInUser(h, { email: 'admin@example.com' });
      member = await signedInUser(h, { email: 'member@example.com' });
      team = await seedTeam(h, { name: 'Payments QA', admins: [admin], members: [member] });
      const first = (await invite('bob@example.com')).body;
      for (const n of [1, 2, 3]) await signedInUser(h, { email: `user${n}@example.com` });
      expect(await renew(first.id)).toMatchObject({ status: 409, body: { code: 'licensing-seat-limit' } });
      expect((await lookup(first.url)).status).toBe(200);
      const rows = await h.tdb.query<{ id: string; revoked: boolean }>(
        "select id, revoked_at is not null as revoked from invitations where email_lower = 'bob@example.com'",
      );
      expect(rows.rows).toEqual([{ id: first.id, revoked: false }]);
    });

    it('records the revoke and the new invite, the invite naming the old id', async () => {
      const first = (await invite('bob@example.com')).body;
      const events = recordingAudit(h.hooks);
      const renewed = (await renew(first.id)).body;
      expect(events.map((e) => [e.action, e.target, e.details])).toEqual([
        [
          'user.invitation_revoked',
          { kind: 'invitation', id: first.id },
          { emailLower: 'bob@example.com', renewed: true },
        ],
        [
          'user.invited',
          { kind: 'invitation', id: renewed.id },
          { emailLower: 'bob@example.com', serverAdmin: false, renewedFrom: first.id },
        ],
      ]);
      expect(events.every((e) => e.actor.kind === 'user')).toBe(true);
    });
  });
});

describeDb('team invitations over OIDC (§3.4, §13.1)', () => {
  const VERIFIER = 'v'.repeat(43);
  const PORT = 49152;
  let idp: FakeOidcIssuer;
  let h: IdentityHarness;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
    h = await teamsHarness({
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
  });
  afterEach(async () => {
    await h.close();
    await idp.close();
  });

  it('the first OIDC sign-in against a team invitation lands the user on the team', async () => {
    const admin = await signedInUser(h, { email: 'admin@example.com' });
    const team = await seedTeam(h, { name: 'Payments QA', admins: [admin] });
    expect(
      (await call(h, admin, 'POST', `/teams/${team.id}/invitations`, { email: 'erin@example.com', role: 'member' }))
        .status,
    ).toBe(201);
    idp.nextUser({ sub: 'sub-erin', email: 'erin@example.com', email_verified: true, name: 'Erin' });
    const started = await call<{ flowId: string; authorizationUrl: string }>(h, undefined, 'POST', '/auth/oidc/start', {
      device: { name: 'Mac' },
      codeChallenge: pkceChallenge(VERIFIER),
      loopbackPort: PORT,
    });
    const back = await idp.authorize(started.body.authorizationUrl);
    const cb = await h.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    const grant = new URL(String(cb.headers['location'])).searchParams.get('grant')!;
    const done = await call<{ token: string; user: { id: string } }>(h, undefined, 'POST', '/auth/oidc/complete', {
      flowId: started.body.flowId,
      grant,
      codeVerifier: VERIFIER,
    });
    expect(done.status).toBe(201);
    expect(await repo.memberRole(h.tdb, team.id, done.body.user.id)).toBe('member');
  });
});
