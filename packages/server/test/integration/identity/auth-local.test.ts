import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import * as repo from '../../../src/identity/repo.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, OIDC_ENV, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
const DEVICE = { name: 'MacBook of Alice' };

describeDb('POST /auth/local/sign-in and /auth/sign-out (§3.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  const signIn = (email: string, password: string, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email, password, device: DEVICE },
      remoteAddress: ip,
    });

  it('answers 201 with a token and the user; the token then authenticates', async () => {
    const alice = await signedInUser(h, { email: 'Alice@example.com', password: PASSWORD });
    const res = await signIn('alice@EXAMPLE.com', PASSWORD);
    expect(res.statusCode).toBe(201);
    const body = res.json<{ token: string; user: { id: string; email: string } }>();
    expect(body.token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(body.user).toEqual({
      id: alice.user.id,
      email: 'Alice@example.com',
      displayName: 'Alice',
      serverAdmin: false,
    });
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect((await repo.tokensOfUser(h.db, alice.user.id)).map((t) => t.deviceName)).toContain('MacBook of Alice');
  });

  it('says the same thing for an unknown email and a wrong password', async () => {
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const unknown = await signIn('nobody@example.com', PASSWORD);
    const wrong = await signIn('alice@example.com', 'not the password');
    expect(unknown.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
    expect(unknown.body).toBe(wrong.body);
    expect(unknown.json<{ code: string }>().code).toBe('identity-invalid-credentials');
  });

  it('distinguishes a disabled user only after a correct password', async () => {
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD, disabled: true });
    expect((await signIn('alice@example.com', 'wrong')).json<{ code: string }>().code).toBe(
      'identity-invalid-credentials',
    );
    expect((await signIn('alice@example.com', PASSWORD)).json<{ code: string }>().code).toBe('identity-user-disabled');
  });

  it('answers 404 identity-method-disabled when local auth is off', async () => {
    await h.close();
    h = await identityHarness({
      env: { WIREBENCH_SERVER_LOCAL_AUTH: 'false', ...OIDC_ENV },
      provider: {
        issuer: 'https://idp.test',
        authorizationUrl: () => 'https://idp.test/a',
        exchange: () => Promise.reject(new Error('unused')),
      },
    });
    const res = await signIn('alice@example.com', PASSWORD);
    expect(res.statusCode).toBe(404);
    expect(res.json<{ code: string }>().code).toBe('identity-method-disabled');
  });

  it('rate-limits the eleventh attempt from one address within a minute, with Retry-After (§3.6)', async () => {
    for (let i = 0; i < 10; i += 1) expect((await signIn(`u${i}@example.com`, 'x'.repeat(12))).statusCode).toBe(401);
    const refused = await signIn('u11@example.com', 'x'.repeat(12));
    expect(refused.statusCode).toBe(429);
    expect(refused.json<{ code: string }>().code).toBe('identity-rate-limited');
    expect(Number(refused.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect((await signIn('other@example.com', 'x'.repeat(12), '10.0.0.2')).statusCode).toBe(401); // another address
    h.clock.advance(60_000);
    expect((await signIn('u11@example.com', 'x'.repeat(12))).statusCode).toBe(401);
  });

  it('rate-limits one email across addresses', async () => {
    for (let i = 0; i < 10; i += 1) await signIn('alice@example.com', 'x'.repeat(12), `10.0.1.${i}`);
    expect((await signIn('ALICE@example.com', 'x'.repeat(12), '10.0.2.1')).statusCode).toBe(429);
  });

  it('rehashes a password stored with older scrypt parameters on a successful sign-in', async () => {
    const { hashPassword } = await import('../../../src/identity/passwords.js');
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    await repo.upsertCredential(
      h.db,
      alice.user.id,
      await hashPassword(PASSWORD, { N: 2 ** 14, r: 8, p: 1, keylen: 32 }),
      h.clock.now,
    );
    expect((await signIn('alice@example.com', PASSWORD)).statusCode).toBe(201);
    expect((await repo.credentialOf(h.db, alice.user.id))?.passwordHash).toMatch(/^scrypt\$32768\$/);
  });

  it('sign-out revokes the calling token and nothing else', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const second = await signedInUser(h, { email: 'alice2@example.com' });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: alice.headers });
    expect(res.statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers })).statusCode).toBe(401);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: second.headers })).statusCode).toBe(200);
    expect((await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out' })).statusCode).toBe(401);
  });

  it('rejects a malformed body as invalid-request without touching the limiter', async () => {
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/local/sign-in', payload: { email: 'x' } });
    expect(res.statusCode).toBe(400);
    expect(res.json<{ code: string }>().code).toBe('invalid-request');
  });
});
