import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';

describeDb('users and password resets (§3.1)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  beforeEach(async () => {
    h = await identityHarness();
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true, password: PASSWORD });
  });
  afterEach(() => h.close());

  const patch = (id: string, payload: object, headers = admin.headers) =>
    h.app.inject({ method: 'PATCH', url: `/api/v1/users/${id}`, headers, payload });

  it('GET /users lists everyone with their methods and disabled state, admins only', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', disabled: true });
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: bob.headers })).statusCode).toBe(403);
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/users', headers: admin.headers });
    expect(res.json()).toEqual([
      {
        id: bob.user.id,
        email: 'bob@example.com',
        displayName: 'bob',
        serverAdmin: false,
        disabledAt: h.clock.now.toISOString(),
        methods: { local: false, oidc: [] },
      },
      {
        id: admin.user.id,
        email: 'root@example.com',
        displayName: 'root',
        serverAdmin: true,
        methods: { local: true, oidc: [] },
      },
    ]);
  });

  it('PATCH toggles admin and disabled; disabling revokes every token; an admin cannot lock themselves out', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    expect((await patch(bob.user.id, { serverAdmin: true })).json<{ serverAdmin: boolean }>().serverAdmin).toBe(true);
    expect((await patch(bob.user.id, { disabled: true })).json<{ disabledAt?: string }>().disabledAt).toBe(
      h.clock.now.toISOString(),
    );
    // Disabling revokes every token, and per spec §3.2 a revoked token is 401 identity-unauthenticated
    // (checked before the disabled-user case, which is for a still-valid token of a disabled user).
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bob.headers })).statusCode).toBe(401);
    expect((await repo.tokensOfUser(h.db, bob.user.id)).length).toBe(0);
    expect((await patch(bob.user.id, { disabled: false })).json<{ disabledAt?: string }>().disabledAt).toBeUndefined();
    expect((await patch(admin.user.id, { serverAdmin: false })).json<{ code: string }>().code).toBe(
      'identity-self-change',
    );
    expect((await patch(admin.user.id, { disabled: true })).json<{ code: string }>().code).toBe('identity-self-change');
    expect((await patch(admin.user.id, { serverAdmin: true })).statusCode).toBe(200);
    expect((await patch('01J8Z0000000000000000000ZZ', { disabled: true })).statusCode).toBe(404);
  });

  it('POST /users/:id/password-reset gives a one-time link; accepting it replaces the credential and revokes every token', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', password: 'old password 123' });
    const res = await h.app.inject({
      method: 'POST',
      url: `/api/v1/users/${bob.user.id}/password-reset`,
      headers: admin.headers,
    });
    expect(res.statusCode).toBe(201);
    const { url } = res.json<{ url: string }>();
    const secret = url.slice(url.lastIndexOf('/') + 1);
    expect(
      (await h.app.inject({ method: 'GET', url: `/api/v1/invitations/lookup?secret=${secret}` })).json<{
        email: string;
      }>().email,
    ).toBe('bob@example.com');
    const accept = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations/accept',
      payload: { secret, displayName: 'Bob', password: PASSWORD, device: { name: 'x' } },
    });
    expect(accept.statusCode).toBe(201);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: bob.headers })).statusCode).toBe(401); // old device
    const signIn = (password: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/local/sign-in',
        payload: { email: 'bob@example.com', password, device: { name: 'y' } },
      });
    expect((await signIn('old password 123')).statusCode).toBe(401);
    expect((await signIn(PASSWORD)).statusCode).toBe(201);
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/invitations/accept',
          payload: { secret, displayName: 'Bob', password: PASSWORD, device: { name: 'x' } },
        })
      ).statusCode,
    ).toBe(404);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/invitations', headers: admin.headers })).json()).toEqual(
      [],
    ); // resets are not in the invite list
    expect(
      (
        await h.app.inject({
          method: 'POST',
          url: '/api/v1/users/01J8Z0000000000000000000ZZ/password-reset',
          headers: admin.headers,
        })
      ).statusCode,
    ).toBe(404);
  });
});
