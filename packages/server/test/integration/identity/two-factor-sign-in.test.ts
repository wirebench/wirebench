import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import type { AuditInput } from '../../../src/context.js';
import { hashSecret } from '../../../src/identity/tokens.js';
import { sealTotpSecret, twoFactorKey } from '../../../src/identity/two-factor/keys.js';
import {
  newRecoveryCodes,
  normaliseRecoveryCode,
  recoveryCodeHash,
} from '../../../src/identity/two-factor/recovery.js';
import * as tf from '../../../src/identity/two-factor/repo.js';
import { newTotpSecret, stepAt, totpAt } from '../../../src/identity/two-factor/totp.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
const DEVICE = { name: 'MacBook of Alice' };
const PUBLIC_URL = 'https://wirebench.test';
const CHALLENGE_COOKIE = '__Host-wb_2fa';
const SESSION_COOKIE = '__Host-wb_session';
const BROWSER_ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };

type Injected = Awaited<ReturnType<IdentityHarness['app']['inject']>>;
const setCookies = (res: Injected): string[] => {
  const header = res.headers['set-cookie'];
  return header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
};
const cookieFrom = (res: Injected, name: string): string | undefined =>
  setCookies(res)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .split(';')[0];
const codeOf = (res: Injected): string => res.json<{ code: string }>().code;

interface Challenge {
  readonly twoFactor: { readonly challenge: string; readonly methods: string[]; readonly setup: boolean };
}

describeDb('two-step sign-in, the second step (spec §3)', () => {
  let h: IdentityHarness;
  let events: AuditInput[];
  beforeEach(async () => {
    h = await identityHarness({ env: BROWSER_ENV });
    events = recordingAudit(h.hooks);
  });
  afterEach(() => h.close());

  const signIn = (email: string, password = PASSWORD, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email, password, device: DEVICE },
      remoteAddress: ip,
    });
  const verify = (challenge: string, method: 'totp' | 'recovery', code: string, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/two-factor/verify',
      payload: { challenge, method, code },
      remoteAddress: ip,
    });
  const challengeOf = async (email = 'alice@example.com'): Promise<string> => {
    const res = await signIn(email);
    expect(res.statusCode, res.body).toBe(200);
    return res.json<Challenge>().twoFactor.challenge;
  };
  const count = async (table: string): Promise<number> =>
    (await h.tdb.query<{ n: number }>(`select count(*)::int as n from ${table}`)).rows[0]!.n;

  /** A user with a password, a confirmed authenticator and ten recovery codes. */
  const withAuthenticator = async (email = 'alice@example.com') => {
    const alice = await signedInUser(h, { email, password: PASSWORD });
    const dataKey = await h.ctx.tenancy.dataKey(h.tdb.scope);
    const secret = newTotpSecret();
    await tf.upsertPendingTotp(h.tdb, alice.user.id, sealTotpSecret(dataKey, alice.user.id, secret), h.clock.now);
    // Confirmed two steps back, so every code of the current window is still unused.
    await tf.confirmTotp(h.tdb, alice.user.id, stepAt(h.clock.now.getTime()) - 2, h.clock.now);
    const codes = newRecoveryCodes();
    const key = twoFactorKey(dataKey, alice.user.id, 'recovery');
    await tf.replaceRecoveryCodes(
      h.tdb,
      alice.user.id,
      codes.map((code) => recoveryCodeHash(key, normaliseRecoveryCode(code)!)),
      h.clock.now,
    );
    const code = (offset = 0) => totpAt(secret, stepAt(h.clock.now.getTime()) + offset);
    return { alice, codes, code };
  };

  it('a person without methods signs in as before', async () => {
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const res = await signIn('alice@example.com');
    expect(res.statusCode).toBe(201);
    expect(res.json<{ token: string }>().token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(await count('identity_two_factor_challenges')).toBe(0);
  });

  it('a person with an authenticator gets a challenge, no token, then a session for a right code', async () => {
    const { alice, code } = await withAuthenticator();
    const tokensBefore = await count('device_tokens');
    const res = await signIn('alice@example.com');
    expect(res.statusCode).toBe(200);
    const body = res.json<Challenge>();
    expect(body).not.toHaveProperty('token');
    expect(body.twoFactor.challenge).toMatch(/^[A-Za-z0-9_-]{43}$/);
    expect(body.twoFactor).toEqual({
      challenge: body.twoFactor.challenge,
      methods: ['totp', 'recovery'],
      setup: false,
    });
    expect(await count('device_tokens')).toBe(tokensBefore);
    // The row keeps the secret's hash only.
    const rows = await h.tdb.query<{ secret_hash: string }>('select secret_hash from identity_two_factor_challenges');
    expect(rows.rows).toEqual([{ secret_hash: hashSecret(body.twoFactor.challenge) }]);
    const done = await verify(body.twoFactor.challenge, 'totp', code());
    expect(done.statusCode, done.body).toBe(201);
    const signed = done.json<{ token: string; user: { id: string } }>();
    expect(signed.token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(signed.user.id).toBe(alice.user.id);
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${signed.token}` },
    });
    expect(me.statusCode).toBe(200);
    expect(await count('identity_two_factor_challenges')).toBe(0);
  });

  it('a wrong code counts; the fifth ends the challenge; a used challenge is expired', async () => {
    const { code } = await withAuthenticator();
    const challenge = await challengeOf();
    for (let i = 0; i < 5; i += 1) {
      const wrong = await verify(challenge, 'totp', '000000');
      expect(wrong.statusCode).toBe(401);
      expect(codeOf(wrong)).toBe('identity-two-factor-invalid');
    }
    expect(codeOf(await verify(challenge, 'totp', code()))).toBe('identity-two-factor-expired');
    const next = await challengeOf();
    expect((await verify(next, 'totp', code())).statusCode).toBe(201);
    expect(codeOf(await verify(next, 'totp', code(1)))).toBe('identity-two-factor-expired');
  });

  it('a code is not accepted twice, even on a new challenge', async () => {
    const { code } = await withAuthenticator();
    expect((await verify(await challengeOf(), 'totp', code())).statusCode).toBe(201);
    const again = await verify(await challengeOf(), 'totp', code());
    expect(again.statusCode).toBe(401);
    expect(codeOf(again)).toBe('identity-two-factor-invalid');
    // An earlier step's code is no better once a later one was used.
    expect((await verify(await challengeOf(), 'totp', code(-1))).statusCode).toBe(401);
    const reasons = events.filter((e) => e.action === 'auth.second_factor_failed').map((e) => e.details?.['reason']);
    expect(reasons).toEqual(['replay', 'replay']);
  });

  it('a recovery code works once, typed loosely', async () => {
    const { codes } = await withAuthenticator();
    const loose = ` ${codes[0]!.toUpperCase().replace('-', ' ')} `;
    expect((await verify(await challengeOf(), 'recovery', loose)).statusCode).toBe(201);
    expect(codeOf(await verify(await challengeOf(), 'recovery', codes[0]!))).toBe('identity-two-factor-invalid');
    expect((await verify(await challengeOf(), 'recovery', codes[1]!)).statusCode).toBe(201);
  });

  it('an expired challenge is refused', async () => {
    const { code } = await withAuthenticator();
    const challenge = await challengeOf();
    h.clock.advance(5 * 60_000 + 1);
    expect(codeOf(await verify(challenge, 'totp', code()))).toBe('identity-two-factor-expired');
  });

  it('a challenge the browser started is not finished by the desktop route', async () => {
    const { code } = await withAuthenticator();
    const form = await h.app.inject({
      method: 'POST',
      url: '/sign-in/local',
      headers: { 'content-type': 'application/x-www-form-urlencoded', origin: PUBLIC_URL },
      payload: new URLSearchParams({ email: 'alice@example.com', password: PASSWORD }).toString(),
    });
    const secret = cookieFrom(form, CHALLENGE_COOKIE)!;
    expect(codeOf(await verify(secret, 'totp', code()))).toBe('identity-two-factor-expired');
  });

  it("the second step charges its own buckets, not the password step's", async () => {
    await withAuthenticator();
    // Ten password sign-ins from one address use up the password step's address bucket...
    const challenges: string[] = [];
    for (let i = 0; i < 10; i += 1) challenges.push(await challengeOf());
    expect((await signIn('alice@example.com')).statusCode).toBe(429);
    // ...and the second step still has its own.
    expect((await verify(challenges[0]!, 'totp', '000000')).statusCode).toBe(401);
  });

  it('ten wrong factors lock the second step for the person, with the usual 429, and audit it once', async () => {
    const { code } = await withAuthenticator();
    let challenge = '';
    for (let i = 0; i < 10; i += 1) {
      // A fresh challenge every five, and a fresh address every time, so only the person's lockout counts.
      if (i % 5 === 0) {
        h.clock.advance(60_000);
        challenge = await challengeOf();
      }
      expect((await verify(challenge, 'totp', '000000', `10.0.3.${i}`)).statusCode).toBe(401);
    }
    h.clock.advance(60_000);
    const locked = await verify(await challengeOf(), 'totp', code(), '10.0.4.1');
    expect(locked.statusCode).toBe(429);
    expect(codeOf(locked)).toBe('identity-rate-limited');
    expect(Number(locked.headers['retry-after'])).toBeGreaterThanOrEqual(1);
    expect(events.filter((e) => e.action === 'auth.second_factor_locked')).toHaveLength(1);
    // An attempt comes back after six minutes.
    h.clock.advance(6 * 60_000);
    expect((await verify(await challengeOf(), 'totp', code(), '10.0.4.2')).statusCode).toBe(201);
  });

  it('every wrong factor answers the same problem, whatever the method or reason', async () => {
    const { code } = await withAuthenticator();
    expect((await verify(await challengeOf(), 'totp', code())).statusCode).toBe(201);
    const answers = [
      await verify(await challengeOf(), 'totp', '000000'),
      await verify(await challengeOf(), 'totp', code()),
      await verify(await challengeOf(), 'totp', 'not a code'),
      await verify(await challengeOf(), 'recovery', 'zzzzz-zzzzz'),
      await verify(await challengeOf(), 'recovery', '!'),
    ];
    expect(new Set(answers.map((res) => `${res.statusCode} ${res.body}`)).size).toBe(1);
  });

  it('records auth.second_factor_failed without the code, and auth.signed_in with secondFactor', async () => {
    const { alice, code } = await withAuthenticator();
    const challenge = await challengeOf();
    await verify(challenge, 'totp', '123456');
    expect((await verify(challenge, 'totp', code())).statusCode).toBe(201);
    const failed = events.find((e) => e.action === 'auth.second_factor_failed')!;
    expect(failed.target).toEqual({ kind: 'user', id: alice.user.id });
    expect(failed.details).toEqual({ method: 'totp', reason: 'wrong-code', attempts: 1 });
    expect(JSON.stringify(events)).not.toContain('123456');
    expect(JSON.stringify(events)).not.toContain(challenge);
    const signedIn = events.filter((e) => e.action === 'auth.signed_in').at(-1)!;
    expect(signedIn.details).toMatchObject({ method: 'local', secondFactor: 'totp', device: DEVICE.name });
  });

  it('the required switch answers a setup challenge to a person without methods', async () => {
    await h.close();
    h = await identityHarness({ env: { ...BROWSER_ENV, WIREBENCH_SERVER_REQUIRE_TWO_FACTOR: 'true' } });
    await signedInUser(h, { email: 'bob@example.com', password: PASSWORD });
    const res = await signIn('bob@example.com');
    expect(res.statusCode).toBe(200);
    const setup = res.json<Challenge>().twoFactor;
    expect(setup).toMatchObject({ methods: [], setup: true });
    // A setup challenge is not a sign-in one: no code finishes it here.
    expect(codeOf(await verify(setup.challenge, 'totp', '000000'))).toBe('identity-two-factor-expired');
  });

  describe('the browser', () => {
    const form = (url: string, fields: Record<string, string>, cookie?: string) =>
      h.app.inject({
        method: 'POST',
        url,
        headers: {
          'content-type': 'application/x-www-form-urlencoded',
          origin: PUBLIC_URL,
          ...(cookie !== undefined ? { cookie } : {}),
        },
        payload: new URLSearchParams(fields).toString(),
      });

    it('the password form sets the challenge cookie and the code form finishes the session', async () => {
      const { code } = await withAuthenticator();
      const first = await form('/sign-in/local', {
        email: 'alice@example.com',
        password: PASSWORD,
        redirect_to: '/w/1',
      });
      expect(first.statusCode).toBe(200);
      expect(cookieFrom(first, SESSION_COOKIE)).toBeUndefined();
      const line = setCookies(first).find((l) => l.startsWith(`${CHALLENGE_COOKIE}=`))!;
      for (const attribute of ['HttpOnly', 'Secure', 'SameSite=Strict', 'Max-Age=300', 'Path=/'])
        expect(line).toContain(attribute);
      const secret = cookieFrom(first, CHALLENGE_COOKIE)!;
      expect(first.body).not.toContain(secret);
      expect(first.body).toContain('action="/sign-in/two-factor"');
      expect(first.body).toContain('name="redirect_to" value="/w/1"');
      expect(first.body).not.toContain('<script');

      const cookie = `${CHALLENGE_COOKIE}=${secret}`;
      const wrong = await form('/sign-in/two-factor', { method: 'totp', code: '000000' }, cookie);
      expect(wrong.statusCode).toBe(401);
      expect(wrong.body).toContain('role="alert"');
      const done = await form('/sign-in/two-factor', { method: 'totp', code: code(), redirect_to: '/w/1' }, cookie);
      expect(done.statusCode).toBe(303);
      expect(done.headers.location).toBe('/w/1');
      expect(cookieFrom(done, SESSION_COOKIE)).toMatch(DEVICE_TOKEN_PATTERN);
      expect(setCookies(done).find((l) => l.startsWith(`${CHALLENGE_COOKIE}=`))).toContain('Max-Age=0');
    });

    it('refuses the code form from another origin, and starts again without the cookie', async () => {
      await withAuthenticator();
      const foreign = await h.app.inject({
        method: 'POST',
        url: '/sign-in/two-factor',
        headers: { 'content-type': 'application/x-www-form-urlencoded', origin: 'https://evil.test' },
        payload: 'method=totp&code=000000',
      });
      expect(foreign.statusCode).toBe(403);
      const none = await form('/sign-in/two-factor', { method: 'totp', code: '000000' });
      expect(none.statusCode).toBe(401);
      expect(none.body).toContain('action="/sign-in/local"');
    });
  });
});
