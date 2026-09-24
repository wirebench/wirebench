import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import {
  identityHarness,
  OIDC_ENV,
  signedInUser,
  type IdentityHarness,
  type SignedInUser,
} from '../../helpers/identity.js';

const DAY = 24 * 60 * 60 * 1000;
const PASSWORD = 'correct horse battery';

describeDb('invitations (§3.1, §3.7)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  beforeEach(async () => {
    h = await identityHarness();
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  });
  afterEach(() => h.close());

  const create = (payload: object, headers = admin.headers) =>
    h.app.inject({ method: 'POST', url: '/api/v1/invitations', headers, payload });
  const lookup = (secret: string, ip = '10.0.0.1') =>
    h.app.inject({ method: 'GET', url: `/api/v1/invitations/lookup?secret=${secret}`, remoteAddress: ip });
  const accept = (payload: object) => h.app.inject({ method: 'POST', url: '/api/v1/invitations/accept', payload });
  const secretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

  it('an admin creates one; the URL carries the secret exactly once and the row only its hash', async () => {
    const res = await create({ email: 'Bob@example.com' });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ id: string; email: string; url: string; expiresAt: string }>();
    expect(body.url).toMatch(/^https:\/\/wirebench\.test\/invite\/[A-Za-z0-9_-]{43}$/);
    expect(body.expiresAt).toBe(new Date(h.clock.now.getTime() + 7 * DAY).toISOString());
    const row = await repo.invitationById(h.db, body.id);
    expect(row).toMatchObject({ email: 'Bob@example.com', serverAdmin: false, createdBy: admin.user.id });
    expect(row?.secretHash).not.toContain(secretOf(body.url).slice(0, 10));
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers });
    expect(list.json<{ id: string; createdBy: string }[]>()).toEqual([
      expect.objectContaining({ id: body.id, createdBy: admin.user.id }),
    ]);
    expect(JSON.stringify(list.json())).not.toContain(secretOf(body.url));
  });

  it('is refused for a non-admin, an existing user, and an email with an open invitation', async () => {
    const member = await signedInUser(h, { email: 'member@example.com' });
    expect((await create({ email: 'x@example.com' }, member.headers)).statusCode).toBe(403);
    expect((await create({ email: 'ROOT@example.com' })).json<{ code: string }>().code).toBe('identity-user-exists');
    await create({ email: 'bob@example.com' });
    expect((await create({ email: 'bob@example.com' })).json<{ code: string }>().code).toBe(
      'identity-invitation-exists',
    );
  });

  it('lookup answers the email and the methods for an open one and 404 for a bad, expired, revoked or used one', async () => {
    const { url, id } = (await create({ email: 'bob@example.com' })).json<{ url: string; id: string }>();
    const secret = secretOf(url);
    expect((await lookup(secret)).json()).toEqual({ email: 'bob@example.com', methods: { local: true, oidc: false } });
    expect((await lookup(mintSecret().secret)).json<{ code: string }>().code).toBe('identity-invitation-invalid');
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/api/v1/invitations/${id}`, headers: admin.headers })).statusCode,
    ).toBe(204);
    expect((await lookup(secret)).statusCode).toBe(404);
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/api/v1/invitations/${id}`, headers: admin.headers })).statusCode,
    ).toBe(404);
    const second = secretOf((await create({ email: 'bob@example.com' })).json<{ url: string }>().url);
    h.clock.advance(8 * DAY);
    expect((await lookup(second)).statusCode).toBe(404);
  });

  it('accept creates the user with a password and a token, marks the invitation, emits the event, and works once', async () => {
    const accepted = vi.fn();
    h.events.on('invitation.accepted', accepted);
    const { url, id } = (await create({ email: 'Bob@example.com', serverAdmin: true })).json<{
      url: string;
      id: string;
    }>();
    const res = await accept({
      secret: secretOf(url),
      displayName: 'Bob',
      password: PASSWORD,
      device: { name: 'Bob laptop' },
    });
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; user: { id: string; email: string; serverAdmin: boolean } }>();
    expect(body.user).toMatchObject({ email: 'Bob@example.com', displayName: 'Bob', serverAdmin: true });
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${body.token}` } }))
        .statusCode,
    ).toBe(200);
    expect((await repo.invitationById(h.db, id))?.acceptedAt).toBe(h.clock.now.toISOString());
    expect(
      (await accept({ secret: secretOf(url), displayName: 'Bob', password: PASSWORD, device: { name: 'x' } }))
        .statusCode,
    ).toBe(404);
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers });
    expect(list.json<{ acceptedAt?: string }[]>()[0]?.acceptedAt).toBe(h.clock.now.toISOString());
    expect(accepted).toHaveBeenCalledWith({ invitationId: id, userId: body.user.id });
  });

  it('accept enforces the password minimum, and answers method-disabled when local auth is off', async () => {
    const { url } = (await create({ email: 'bob@example.com' })).json<{ url: string }>();
    expect(
      (await accept({ secret: secretOf(url), displayName: 'Bob', password: 'short', device: { name: 'x' } })).json<{
        code: string;
      }>().code,
    ).toBe('identity-password-too-short');
    await h.close();
    h = await identityHarness({
      env: { WIREBENCH_SERVER_LOCAL_AUTH: 'false', ...OIDC_ENV },
      provider: {
        issuer: 'https://idp.test',
        authorizationUrl: () => 'https://idp.test/a',
        exchange: () => Promise.reject(new Error('unused')),
      },
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const oidcOnly = (await create({ email: 'bob@example.com' })).json<{ url: string }>();
    expect((await lookup(secretOf(oidcOnly.url))).json()).toEqual({
      email: 'bob@example.com',
      methods: { local: false, oidc: true },
    });
    expect(
      (
        await accept({ secret: secretOf(oidcOnly.url), displayName: 'Bob', password: PASSWORD, device: { name: 'x' } })
      ).json<{ code: string }>().code,
    ).toBe('identity-method-disabled');
  });

  it('rate-limits lookups per address', async () => {
    for (let i = 0; i < 10; i += 1) await lookup(mintSecret().secret);
    expect((await lookup(mintSecret().secret)).statusCode).toBe(429);
    expect((await lookup(mintSecret().secret, '10.0.0.9')).statusCode).toBe(404);
  });

  it('serves the invitation page at the root for an open code and the closed variant otherwise', async () => {
    const { url } = (await create({ email: 'bob@example.com' })).json<{ url: string }>();
    const open = await h.app.inject({ method: 'GET', url: `/invite/${secretOf(url)}` });
    expect(open.statusCode).toBe(200);
    expect(open.headers['content-type']).toContain('text/html');
    expect(open.headers['content-security-policy']).toBe("default-src 'none'; style-src 'unsafe-inline'");
    expect(open.body).toContain('bob@example.com');
    expect(open.body).toContain(secretOf(url));
    const closed = await h.app.inject({ method: 'GET', url: `/invite/${mintSecret().secret}` });
    expect(closed.statusCode).toBe(200);
    expect(closed.body).toContain('This invitation has expired or was already used.');
    expect((await h.app.inject({ method: 'GET', url: '/invite/not-a-secret' })).statusCode).toBe(404);
  });
});
