import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { AuditInput } from '../../../src/context.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { SoftAuthenticator } from '../../helpers/soft-authenticator.js';

const PASSWORD = 'correct horse battery';
const KEY_ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };
/** The harness's public URL: the relying party (spec §3.5). */
const ORIGIN = 'https://wirebench.test';
const RP_ID = 'wirebench.test';

describeDb('two-step sign-in, passkeys (spec §3.5, §5.2)', () => {
  let h: IdentityHarness;
  let events: AuditInput[];
  beforeEach(async () => {
    h = await identityHarness({ env: KEY_ENV });
    events = recordingAudit(h.hooks);
  });
  afterEach(() => h.close());

  const call = (
    user: SignedInUser | undefined,
    method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
    url: string,
    payload?: object,
  ) =>
    h.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(user !== undefined ? { headers: user.headers } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
  const codeOf = (res: { json: <T>() => T }) => res.json<{ code: string }>().code;

  /** Registers `authenticator` for `user` under `name`; answers the server's answer. */
  const register = async (user: SignedInUser, authenticator: SoftAuthenticator, name = 'Laptop') => {
    const options = await call(user, 'POST', '/me/two-factor/passkeys/options', { password: PASSWORD });
    expect(options.statusCode, options.body).toBe(200);
    return call(user, 'POST', '/me/two-factor/passkeys', {
      name,
      response: authenticator.create(options.json<{ challenge: string }>()),
    });
  };
  const challengeOf = async (email = 'alice@example.com') => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email, password: PASSWORD, device: { name: 'Mac' } },
    });
    expect(res.statusCode, res.body).toBe(200);
    return res.json<{ twoFactor: { challenge: string; methods: string[] } }>().twoFactor;
  };
  const passkeyStep = async (challenge: string, authenticator: SoftAuthenticator, origin = ORIGIN) => {
    const options = await call(undefined, 'POST', '/auth/two-factor/passkey/options', { challenge });
    expect(options.statusCode, options.body).toBe(200);
    return call(undefined, 'POST', '/auth/two-factor/passkey/verify', {
      challenge,
      response: authenticator.get(options.json<{ challenge: string }>(), origin),
    });
  };

  it('registers a passkey after the password, and lists it by name', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    expect(codeOf(await call(alice, 'POST', '/me/two-factor/passkeys/options', { password: 'wrong one' }))).toBe(
      'identity-invalid-credentials',
    );
    const options = await call(alice, 'POST', '/me/two-factor/passkeys/options', { password: PASSWORD });
    const body = options.json<{ rp: { id: string }; user: { name: string }; attestation: string }>();
    expect(body.rp.id).toBe(RP_ID);
    expect(body.user.name).toBe('alice@example.com');
    expect(body.attestation).toBe('none');
    // Another origin's answer is refused, and spends the registration.
    const foreign = await call(alice, 'POST', '/me/two-factor/passkeys', {
      name: 'Laptop',
      response: key.create(options.json<{ challenge: string }>(), 'https://evil.test'),
    });
    expect(codeOf(foreign)).toBe('identity-passkey-failed');
    const added = await register(alice, key);
    expect(added.statusCode, added.body).toBe(201);
    const answer = added.json<{ passkey: { id: string; name: string }; recoveryCodes: string[] }>();
    expect(answer.passkey.name).toBe('Laptop');
    expect(answer.recoveryCodes).toHaveLength(10);
    const status = (await call(alice, 'GET', '/me/two-factor')).json<{
      enabled: boolean;
      passkeys: { id: string; name: string; lastUsedAt: string | null }[];
    }>();
    expect(status.enabled).toBe(true);
    expect(status.passkeys).toEqual([
      { id: answer.passkey.id, name: 'Laptop', createdAt: h.clock.now.toISOString(), lastUsedAt: null },
    ]);
    // The same key again is refused; a second key brings no new codes.
    expect(codeOf(await register(alice, key))).toBe('identity-passkey-failed');
    const second = await register(alice, new SoftAuthenticator(RP_ID, ORIGIN), 'Phone');
    expect(second.json<{ recoveryCodes?: string[] }>().recoveryCodes).toBeUndefined();
    expect(events.filter((e) => e.action === 'user.two_factor_method_added').map((e) => e.details)).toEqual([
      { method: 'passkey', passkeyId: answer.passkey.id },
      { method: 'passkey', passkeyId: second.json<{ passkey: { id: string } }>().passkey.id },
    ]);
  });

  it('signs in with the passkey as the second step', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    await register(alice, key);
    const challenge = await challengeOf();
    expect(challenge.methods).toEqual(['passkey', 'recovery']);
    const done = await passkeyStep(challenge.challenge, key);
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json<{ token: string }>().token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(events.filter((e) => e.action === 'auth.signed_in').at(-1)?.details).toMatchObject({
      secondFactor: 'passkey',
    });
    const status = (await call(alice, 'GET', '/me/two-factor')).json<{ passkeys: { lastUsedAt: string }[] }>();
    expect(status.passkeys[0]!.lastUsedAt).toBe(h.clock.now.toISOString());
    // The challenge is taken.
    const again = await call(undefined, 'POST', '/auth/two-factor/passkey/options', {
      challenge: challenge.challenge,
    });
    expect(codeOf(again)).toBe('identity-two-factor-expired');
  });

  it('refuses an unknown credential, another origin, and a counter that goes backwards', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    await register(alice, key);
    expect((await passkeyStep((await challengeOf()).challenge, key)).statusCode).toBe(201);
    const { challenge } = await challengeOf();
    const answers = [
      await passkeyStep(challenge, new SoftAuthenticator(RP_ID, ORIGIN)),
      await passkeyStep(challenge, key, 'https://evil.test'),
    ];
    // Back to a counter the server has already seen.
    key.counter = 0;
    answers.push(await passkeyStep(challenge, key));
    for (const answer of answers) {
      expect(answer.statusCode).toBe(401);
      expect(codeOf(answer)).toBe('identity-two-factor-invalid');
    }
    const reasons = events.filter((e) => e.action === 'auth.second_factor_failed').map((e) => e.details?.['reason']);
    expect(reasons).toEqual(['passkey-unknown', 'passkey-invalid', 'passkey-counter']);
    // An answer without its options is no answer.
    const unasked = await call(undefined, 'POST', '/auth/two-factor/passkey/verify', {
      challenge,
      response: key.get({ challenge: 'never-asked' }),
    });
    expect(codeOf(unasked)).toBe('identity-passkey-failed');
  });

  it('an eleventh passkey is refused', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    for (let i = 0; i < 10; i += 1) {
      h.clock.advance(60_000);
      expect((await register(alice, new SoftAuthenticator(RP_ID, ORIGIN), `Key ${i}`)).statusCode).toBe(201);
    }
    h.clock.advance(60_000);
    const refused = await call(alice, 'POST', '/me/two-factor/passkeys/options', { password: PASSWORD });
    expect(refused.statusCode).toBe(409);
    expect(codeOf(refused)).toBe('identity-passkey-limit');
  });

  it('rename needs no password; remove does', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const added = await register(alice, new SoftAuthenticator(RP_ID, ORIGIN));
    const id = added.json<{ passkey: { id: string } }>().passkey.id;
    const renamed = await call(alice, 'PATCH', `/me/two-factor/passkeys/${id}`, { name: 'Work laptop' });
    expect(renamed.statusCode).toBe(204);
    expect((await call(alice, 'PATCH', '/me/two-factor/passkeys/nope', { name: 'x' })).statusCode).toBe(404);
    const status = (await call(alice, 'GET', '/me/two-factor')).json<{ passkeys: { name: string }[] }>();
    expect(status.passkeys.map((p) => p.name)).toEqual(['Work laptop']);
    expect(codeOf(await call(alice, 'DELETE', `/me/two-factor/passkeys/${id}`, { password: 'wrong one' }))).toBe(
      'identity-invalid-credentials',
    );
    const removed = await call(alice, 'DELETE', `/me/two-factor/passkeys/${id}`, { password: PASSWORD });
    expect(removed.statusCode).toBe(204);
    // The last method: two-step sign-in is off and the codes are gone.
    expect((await call(alice, 'GET', '/me/two-factor')).json()).toMatchObject({
      enabled: false,
      passkeys: [],
      recoveryCodesLeft: 0,
    });
    expect(events.filter((e) => e.action === 'user.two_factor_method_removed').map((e) => e.details)).toEqual([
      { method: 'passkey', passkeyId: id },
    ]);
  });
});
