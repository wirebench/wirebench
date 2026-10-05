import { afterEach, beforeEach, expect, it } from 'vitest';
import { SYSTEM_SOURCE } from '../../../src/context.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { pkceChallenge } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';

const keys = testKeys();
const SERVER_ID = '0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90';
const PASSWORD = 'correct horse battery staple';
const secretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

let h: IdentityHarness | undefined;
afterEach(async () => {
  await h?.close();
  h = undefined;
});

/** A server admin plus `members` more enabled accounts. */
async function withAccounts(
  members: number,
): Promise<{ h: IdentityHarness; admin: SignedInUser; users: SignedInUser[] }> {
  h = await licensingHarness(keys);
  const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
  const users: SignedInUser[] = [];
  for (let i = 1; i <= members; i += 1) users.push(await signedInUser(h, { email: `user${i}@example.com` }));
  return { h, admin, users };
}

const accept = (harness: IdentityHarness, url: string, name: string) =>
  harness.app.inject({
    method: 'POST',
    url: '/api/v1/invitations/accept',
    payload: { secret: secretOf(url), displayName: name, password: PASSWORD, device: { name: 'laptop' } },
  });

describeDb('seats on Community (licensing spec §3.4, §13.1)', () => {
  it('the fifth enabled account gets in; the sixth invitation is refused before the invitee hears of it', async () => {
    const { h, admin } = await withAccounts(3);
    const fifth = await call<{ url: string }>(h, admin, 'POST', '/invitations', { email: 'fifth@example.com' });
    expect(fifth.status).toBe(201);
    expect((await accept(h, fifth.body.url, 'Fifth')).statusCode).toBe(201);
    const sixth = await call<{ code: string; message: string }>(h, admin, 'POST', '/invitations', {
      email: 'sixth@example.com',
    });
    expect(sixth.status).toBe(409);
    expect(sixth.body.code).toBe('licensing-seat-limit');
    expect(sixth.body.message).toContain('5 enabled accounts');
    expect(sixth.body.message).toContain('Community');
  });

  it('a team invitation counts the same way', async () => {
    const { h, admin } = await withAccounts(4);
    // teams-access is not registered here: the shared createInvitation, which a team invitation calls, refuses.
    const { createInvitation } = await import('../../../src/identity/invitations.js');
    const { identitySettings } = await import('../../../src/identity/env.js');
    const { loadConfig } = await import('../../../src/config.js');
    const { createLicenseService } = await import('../../../src/licensing/service.js');
    const config = loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: h.db.url,
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: h.dataDir,
      },
      '0.0.0-test',
    );
    const env = {
      ctx: {
        db: h.db,
        config,
        hooks: h.hooks,
        license: createLicenseService({
          db: h.db,
          publicKeys: [keys.publicKey],
          now: () => h.clock.now,
          serverId: SERVER_ID,
        }),
      },
      settings: identitySettings(config),
      now: () => h.clock.now,
    };
    let attached = false;
    await expect(
      createInvitation(
        env,
        { email: 'team@example.com', serverAdmin: false, createdBy: admin.user.id, source: SYSTEM_SOURCE },
        () => {
          attached = true;
          return Promise.resolve();
        },
      ),
    ).rejects.toMatchObject({ code: 'licensing-seat-limit' });
    expect(attached).toBe(false);
  });

  it('an acceptance at the limit is refused and the invitation stays open, so it goes through once a seat frees', async () => {
    const { h, admin, users } = await withAccounts(3);
    const invited = await call<{ id: string; url: string }>(h, admin, 'POST', '/invitations', {
      email: 'late@example.com',
    });
    await signedInUser(h, { email: 'filler@example.com' }); // the fifth seat goes to someone else first
    const refused = await accept(h, invited.body.url, 'Late');
    expect(refused.statusCode).toBe(409);
    expect(refused.json<{ code: string }>().code).toBe('licensing-seat-limit');
    expect((await identityRepo.invitationById(h.db, invited.body.id))?.acceptedAt).toBeNull();

    expect((await call(h, admin, 'PATCH', `/users/${users[0]!.user.id}`, { disabled: true })).status).toBe(200);
    expect((await accept(h, invited.body.url, 'Late')).statusCode).toBe(201);
  });

  it('re-enabling an account is refused at the limit; re-saving an enabled one is not', async () => {
    const { h, admin, users } = await withAccounts(4);
    const parked = await signedInUser(h, { email: 'parked@example.com', disabled: true });
    const refused = await call<{ code: string }>(h, admin, 'PATCH', `/users/${parked.user.id}`, { disabled: false });
    expect(refused.status).toBe(409);
    expect(refused.body.code).toBe('licensing-seat-limit');
    expect((await identityRepo.findUserById(h.db, parked.user.id))?.disabledAt).not.toBeNull();
    expect((await call(h, admin, 'PATCH', `/users/${users[0]!.user.id}`, { disabled: false })).status).toBe(200);
  });

  it('a password reset never counts', async () => {
    const { h, admin, users } = await withAccounts(4);
    const reset = await call<{ url: string }>(h, admin, 'POST', `/users/${users[0]!.user.id}/password-reset`);
    expect(reset.status).toBe(201);
    expect((await accept(h, reset.body.url, 'ignored')).statusCode).toBe(201);
  });

  it('over the limit after a downgrade, nobody is disabled and only new accounts are refused', async () => {
    const { h, admin } = await withAccounts(3);
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    for (let i = 0; i < 6; i += 1) await signedInUser(h, { email: `extra${i}@example.com` });
    expect((await call(h, admin, 'DELETE', '/license')).status).toBe(204);
    const users = await identityRepo.listUsers(h.db);
    expect(users.filter((user) => user.disabledAt === null)).toHaveLength(10);
    expect((await call(h, admin, 'GET', '/me')).status).toBe(200);
    expect(
      (await call<{ code: string }>(h, admin, 'POST', '/invitations', { email: 'new@example.com' })).body.code,
    ).toBe('licensing-seat-limit');
  });

  it('a Team license lifts the cap on the next request', async () => {
    const { h, admin } = await withAccounts(4);
    expect((await call(h, admin, 'POST', '/invitations', { email: 'sixth@example.com' })).status).toBe(409);
    await call(h, admin, 'PUT', '/license', { license: license(keys) });
    expect((await call(h, admin, 'POST', '/invitations', { email: 'sixth@example.com' })).status).toBe(201);
  });

  it('two acceptances racing for the last seat admit exactly one', async () => {
    const { h, admin } = await withAccounts(3);
    const first = await call<{ url: string }>(h, admin, 'POST', '/invitations', { email: 'first@example.com' });
    const second = await call<{ url: string }>(h, admin, 'POST', '/invitations', { email: 'second@example.com' });
    const results = await Promise.all([accept(h, first.body.url, 'First'), accept(h, second.body.url, 'Second')]);
    expect(results.map((res) => res.statusCode).sort()).toEqual([201, 409]);
    const enabled = (await identityRepo.listUsers(h.db)).filter((user) => user.disabledAt === null);
    expect(enabled).toHaveLength(5);
  });
});

describeDb('the first OIDC sign-in counts a seat (licensing spec §3.4)', () => {
  let idp: FakeOidcIssuer;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
  });
  afterEach(async () => {
    await idp.close();
  });

  it('redirects to the loopback with licensing-seat-limit and leaves the invitation open', async () => {
    h = await licensingHarness(keys, {
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
    const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
    for (let i = 1; i <= 3; i += 1) await signedInUser(h, { email: `user${i}@example.com` });
    const invited = await call<{ id: string }>(h, admin, 'POST', '/invitations', { email: 'alice@example.com' });
    expect(invited.status).toBe(201);
    await signedInUser(h, { email: 'filler@example.com' });

    idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true, name: 'Alice' });
    const started = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/start',
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge('v'.repeat(43)), loopbackPort: 49152 },
    });
    const { authorizationUrl } = started.json<{ authorizationUrl: string }>();
    const back = await idp.authorize(authorizationUrl);
    const callback = await h.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
    expect(callback.statusCode).toBe(302);
    expect(new URL(String(callback.headers['location'])).searchParams.get('error')).toBe('licensing-seat-limit');
    expect((await identityRepo.invitationById(h.db, invited.body.id))?.acceptedAt).toBeNull();
    expect(await identityRepo.findUserByEmail(h.db, 'alice@example.com')).toBeUndefined();
  });
});
