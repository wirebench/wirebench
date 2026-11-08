import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { sweepExpired } from '../../../src/identity/sessions.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

describeDb('/me (§3.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  it('GET /me reports the user and the methods they can sign in with', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD, serverAdmin: true });
    await repo.insertOidcIdentity(h.tdb, {
      issuer: 'https://idp.test',
      subject: 's',
      userId: alice.user.id,
      at: h.clock.now,
    });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers });
    expect(res.json()).toEqual({
      user: {
        id: alice.user.id,
        email: 'alice@example.com',
        displayName: 'alice',
        serverAdmin: true,
        username: null,
        about: '',
        photo: null,
        cover: null,
      },
      methods: { local: true, oidc: [{ issuer: 'https://idp.test' }] },
      twoFactor: false,
    });
  });

  it('POST /me/password needs the current password when one exists, enforces the minimum, and revokes the other devices', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const phone = await signedInUser(h, { email: 'alice@example.com' }).catch(() => undefined); // same email: insertUser refuses
    expect(phone).toBeUndefined();
    const { mintToken, newId } = await import('../../../src/identity/tokens.js');
    const other = mintToken();
    await repo.insertToken(h.tdb, {
      id: newId(),
      userId: alice.user.id,
      tokenHash: other.hash,
      deviceName: 'phone',
      at: h.clock.now,
    });
    const post = (payload: object) =>
      h.app.inject({ method: 'POST', url: '/api/v1/me/password', headers: alice.headers, payload });
    expect((await post({ newPassword: 'n'.repeat(12) })).json<{ code: string }>().code).toBe(
      'identity-invalid-credentials',
    );
    expect((await post({ currentPassword: 'wrong', newPassword: 'n'.repeat(12) })).json<{ code: string }>().code).toBe(
      'identity-invalid-credentials',
    );
    expect((await post({ currentPassword: PASSWORD, newPassword: 'short' })).json<{ code: string }>().code).toBe(
      'identity-password-too-short',
    );
    expect((await post({ currentPassword: PASSWORD, newPassword: 'n'.repeat(12) })).statusCode).toBe(204);
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers })).statusCode).toBe(200);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${other.token}` } }))
        .statusCode,
    ).toBe(401);
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'alice@example.com', password: 'n'.repeat(12), device: { name: 'x' } },
    });
    expect(signIn.statusCode).toBe(201);
  });

  it('POST /me/password sets a first password for an OIDC-only user without a current one', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/me/password',
      headers: alice.headers,
      payload: { newPassword: 'n'.repeat(12) },
    });
    expect(res.statusCode).toBe(204);
    expect(await repo.credentialOf(h.tdb, alice.user.id)).toBeDefined();
  });

  it('GET /me/devices lists live tokens with `current`, and DELETE revokes one of the caller’s own', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', deviceName: 'laptop' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    const { mintToken, newId } = await import('../../../src/identity/tokens.js');
    const phoneId = newId();
    await repo.insertToken(h.tdb, {
      id: phoneId,
      userId: alice.user.id,
      tokenHash: mintToken().hash,
      deviceName: 'phone',
      at: h.clock.now,
    });
    const list = await h.app.inject({ method: 'GET', url: '/api/v1/me/devices', headers: alice.headers });
    expect(list.json<{ name: string; current: boolean }[]>().map((d) => [d.name, d.current])).toEqual([
      ['laptop', true],
      ['phone', false],
    ]);
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/api/v1/me/devices/${bob.tokenId}`, headers: alice.headers }))
        .statusCode,
    ).toBe(404);
    expect(
      (await h.app.inject({ method: 'DELETE', url: `/api/v1/me/devices/${phoneId}`, headers: alice.headers }))
        .statusCode,
    ).toBe(204);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/v1/me/devices', headers: alice.headers })).json(),
    ).toHaveLength(1);
  });

  const patchMe = (headers: Record<string, string> | undefined, payload: object) =>
    h.app.inject({ method: 'PATCH', url: '/api/v1/me', ...(headers !== undefined ? { headers } : {}), payload });

  it('PATCH /me trims and stores the name; GET /me shows it', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const res = await patchMe(alice.headers, { name: '  Alice Liddell  ' });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { displayName: string } }>().user.displayName).toBe('Alice Liddell');
    const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: alice.headers });
    expect(me.json()).toEqual(res.json());
    expect((await repo.findUserById(h.tdb, alice.user.id))?.displayName).toBe('Alice Liddell');
  });

  it('refuses a blank and a 121-character name with 400', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const blank = await patchMe(alice.headers, { name: '   ' });
    expect(blank.statusCode).toBe(400);
    expect(blank.json<{ code: string }>().code).toBe('identity-name-invalid');
    expect((await patchMe(alice.headers, { name: 'a'.repeat(121) })).statusCode).toBe(400);
    expect((await patchMe(alice.headers, { name: 'a'.repeat(120) })).statusCode).toBe(200);
  });

  it('records user.updated once, with the field name and no value', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const events = recordingAudit(h.hooks);
    await patchMe(alice.headers, { name: 'Alice Liddell' });
    expect(events.map((e) => [e.action, e.target, e.details])).toEqual([
      ['user.updated', { kind: 'user', id: alice.user.id }, { fields: ['displayName'], via: 'self' }],
    ]);
    expect(JSON.stringify(events)).not.toContain('Liddell');
    expect((await patchMe(alice.headers, { name: ' Alice Liddell ' })).statusCode).toBe(200);
    expect(events).toHaveLength(1);
  });

  it('needs a signed-in user', async () => {
    const res = await patchMe(undefined, { name: 'Alice' });
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('identity-unauthenticated');
  });

  it('the sweep deletes tokens idle 30 days, older than 180 days, or revoked over a day ago', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const bob = await signedInUser(h, { email: 'bob@example.com' });
    await repo.revokeToken(h.tdb, bob.tokenId, h.clock.now);
    h.clock.advance(2 * DAY);
    const carol = await signedInUser(h, { email: 'carol@example.com' });
    h.clock.advance(29 * DAY);
    await sweepExpired({
      ctx: h.ctx,
      settings: { tokenIdleMs: 30 * DAY, tokenMaxMs: 180 * DAY } as never,
      now: () => h.clock.now,
    });
    expect(await repo.tokensOfUser(h.tdb, alice.user.id)).toHaveLength(0);
    expect(
      (await h.tdb.query('select count(*)::int as n from device_tokens where user_id = $1', [bob.user.id])).rows[0],
    ).toEqual({ n: 0 });
    expect(await repo.tokensOfUser(h.tdb, carol.user.id)).toHaveLength(1);
  });
});
