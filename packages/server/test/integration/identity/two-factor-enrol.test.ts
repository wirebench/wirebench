import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { local, type AuditInput, type SessionEnded } from '../../../src/context.js';
import { stepAt, totpAt } from '../../../src/identity/two-factor/totp.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';

const PASSWORD = 'correct horse battery';
/** A server always has a secrets key (it makes one when none is set); the harness needs it named. */
const KEY_ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** The bytes of an RFC 4648 base32 string, as the setup answers the key. */
function fromBase32(text: string): Buffer {
  let bits = 0;
  let value = 0;
  const out: number[] = [];
  for (const char of text) {
    value = ((value << 5) | BASE32.indexOf(char)) & 0xffff;
    bits += 5;
    if (bits >= 8) {
      out.push((value >>> (bits - 8)) & 255);
      bits -= 8;
    }
  }
  return Buffer.from(out);
}

describeDb('two-step sign-in, setting it up (spec §5, §7)', () => {
  let h: IdentityHarness;
  let events: AuditInput[];
  beforeEach(async () => {
    h = await identityHarness({ env: KEY_ENV });
    events = recordingAudit(h.hooks);
  });
  afterEach(() => h.close());

  const call = (user: SignedInUser | undefined, method: 'GET' | 'POST' | 'DELETE', url: string, payload?: object) =>
    h.app.inject({
      method,
      url: `/api/v1${url}`,
      ...(user !== undefined ? { headers: user.headers } : {}),
      ...(payload !== undefined ? { payload } : {}),
    });
  const codeOf = (res: { json: <T>() => T }) => res.json<{ code: string }>().code;
  const status = async (user: SignedInUser) =>
    (await call(user, 'GET', '/me/two-factor')).json<Record<string, unknown>>();

  /** Sets up and confirms an authenticator for `user`; answers its key and the recovery codes. */
  const enrol = async (user: SignedInUser) => {
    const setup = await call(user, 'POST', '/me/two-factor/totp', { password: PASSWORD });
    expect(setup.statusCode, setup.body).toBe(200);
    const key = fromBase32(setup.json<{ secret: string }>().secret);
    const code = (offset = 0) => totpAt(key, stepAt(h.clock.now.getTime()) + offset);
    const confirmed = await call(user, 'POST', '/me/two-factor/totp/confirm', { code: code() });
    expect(confirmed.statusCode, confirmed.body).toBe(200);
    return { key, code, recoveryCodes: confirmed.json<{ recoveryCodes: string[] }>().recoveryCodes };
  };

  it('setting up an authenticator needs the password, answers a QR code, and stays pending until confirmed', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    expect(codeOf(await call(alice, 'POST', '/me/two-factor/totp', { password: 'not the password' }))).toBe(
      'identity-invalid-credentials',
    );
    expect(codeOf(await call(alice, 'POST', '/me/two-factor/totp', {}))).toBe('identity-invalid-credentials');
    expect((await call(undefined, 'POST', '/me/two-factor/totp', { password: PASSWORD })).statusCode).toBe(401);
    const setup = await call(alice, 'POST', '/me/two-factor/totp', { password: PASSWORD });
    const body = setup.json<{ uri: string; qrSvg: string; secret: string }>();
    expect(body.secret).toMatch(/^[A-Z2-7]{32}$/);
    expect(body.uri).toContain(`secret=${body.secret}`);
    expect(body.uri.startsWith(`otpauth://totp/${encodeURIComponent('Wirebench (')}`)).toBe(true);
    expect(body.qrSvg.startsWith('<svg')).toBe(true);
    // Pending: not on, and not a method at sign-in.
    expect(await status(alice)).toMatchObject({ available: true, enabled: false, totp: null });
    const key = fromBase32(body.secret);
    expect(codeOf(await call(alice, 'POST', '/me/two-factor/totp/confirm', { code: '000000' }))).toBe(
      'identity-two-factor-invalid',
    );
    // Ten minutes unconfirmed, and it is gone.
    h.clock.advance(10 * 60_000 + 1);
    const late = await call(alice, 'POST', '/me/two-factor/totp/confirm', {
      code: totpAt(key, stepAt(h.clock.now.getTime())),
    });
    expect(codeOf(late)).toBe('identity-two-factor-setup-expired');
  });

  it('confirming answers ten recovery codes once; the status shows enabled and 10 left', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const { recoveryCodes } = await enrol(alice);
    expect(recoveryCodes).toHaveLength(10);
    expect(new Set(recoveryCodes).size).toBe(10);
    expect(await status(alice)).toMatchObject({
      available: true,
      enabled: true,
      required: false,
      totp: { addedAt: h.clock.now.toISOString() },
      passkeys: [],
      recoveryCodesLeft: 10,
    });
    // A second authenticator is refused while one is set up.
    expect(codeOf(await call(alice, 'POST', '/me/two-factor/totp', { password: PASSWORD }))).toBe(
      'identity-two-factor-exists',
    );
    const me = await call(alice, 'GET', '/me');
    expect(me.json<{ twoFactor: boolean }>().twoFactor).toBe(true);
    // The codes are never answered again.
    expect(JSON.stringify(await status(alice))).not.toContain(recoveryCodes[0]);
  });

  it('making new codes voids the old set', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const { recoveryCodes: old } = await enrol(alice);
    const made = await call(alice, 'POST', '/me/two-factor/recovery-codes', { password: PASSWORD });
    expect(made.statusCode).toBe(200);
    const fresh = made.json<{ recoveryCodes: string[] }>().recoveryCodes;
    expect(fresh).toHaveLength(10);
    expect(fresh).not.toContain(old[0]);
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'alice@example.com', password: PASSWORD, device: { name: 'Mac' } },
    });
    const challenge = signIn.json<{ twoFactor: { challenge: string } }>().twoFactor.challenge;
    const verify = (code: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/two-factor/verify',
        payload: { challenge, method: 'recovery', code },
      });
    expect((await verify(old[0]!)).statusCode).toBe(401);
    expect((await verify(fresh[0]!)).statusCode).toBe(201);
  });

  it('removing the last method turns it off and deletes the codes; refused while required', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    await enrol(alice);
    expect(codeOf(await call(alice, 'DELETE', '/me/two-factor/totp', { password: 'wrong password' }))).toBe(
      'identity-invalid-credentials',
    );
    expect((await call(alice, 'DELETE', '/me/two-factor/totp', { password: PASSWORD })).statusCode).toBe(204);
    expect(await status(alice)).toMatchObject({ enabled: false, totp: null, recoveryCodesLeft: 0 });
    expect(codeOf(await call(alice, 'POST', '/me/two-factor/recovery-codes', { password: PASSWORD }))).toBe(
      'identity-two-factor-off',
    );
    expect((await call(alice, 'DELETE', '/me/two-factor/totp', { password: PASSWORD })).statusCode).toBe(404);

    await h.close();
    h = await identityHarness({ env: { ...KEY_ENV, WIREBENCH_SERVER_REQUIRE_TWO_FACTOR: 'true' } });
    const bob = await signedInUser(h, { email: 'bob@example.com', password: PASSWORD });
    await enrol(bob);
    const refused = await call(bob, 'DELETE', '/me/two-factor/totp', { password: PASSWORD });
    expect(refused.statusCode).toBe(403);
    expect(codeOf(refused)).toBe('identity-two-factor-required');
    expect(await status(bob)).toMatchObject({ enabled: true, required: true, recoveryCodesLeft: 10 });
  });

  it('an SSO-only person is told two-step sign-in needs a password', async () => {
    const carol = await signedInUser(h, { email: 'carol@example.com' });
    expect(await status(carol)).toEqual({ available: false });
    expect(codeOf(await call(carol, 'POST', '/me/two-factor/totp', { password: PASSWORD }))).toBe(
      'identity-method-disabled',
    );
  });

  it('a setup challenge reaches only the setup routes and its confirm signs in', async () => {
    await h.close();
    h = await identityHarness({ env: { ...KEY_ENV, WIREBENCH_SERVER_REQUIRE_TWO_FACTOR: 'true' } });
    events = recordingAudit(h.hooks);
    await signedInUser(h, { email: 'dave@example.com', password: PASSWORD });
    const signIn = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/local/sign-in',
      payload: { email: 'dave@example.com', password: PASSWORD, device: { name: 'Dave’s Mac' } },
    });
    const challenge = signIn.json<{ twoFactor: { challenge: string; setup: boolean } }>().twoFactor;
    expect(challenge.setup).toBe(true);
    const headers = { authorization: `TwoFactor ${challenge.challenge}` };
    const setupCall = (method: 'GET' | 'POST', url: string, payload?: object) =>
      h.app.inject({ method, url: `/api/v1${url}`, headers, ...(payload !== undefined ? { payload } : {}) });
    // Not a session: every other route refuses it.
    expect((await setupCall('GET', '/me')).statusCode).toBe(401);
    expect((await setupCall('GET', '/me/two-factor')).statusCode).toBe(401);
    expect((await setupCall('POST', '/me/two-factor/recovery-codes', { password: PASSWORD })).statusCode).toBe(401);
    // The setup needs no password: one was checked moments ago.
    const setup = await setupCall('POST', '/me/two-factor/totp', {});
    expect(setup.statusCode, setup.body).toBe(200);
    const key = fromBase32(setup.json<{ secret: string }>().secret);
    const done = await setupCall('POST', '/me/two-factor/totp/confirm', {
      code: totpAt(key, stepAt(h.clock.now.getTime())),
    });
    expect(done.statusCode, done.body).toBe(201);
    const session = done.json<{ token: string; recoveryCodes: string[] }>();
    expect(session.token).toMatch(DEVICE_TOKEN_PATTERN);
    expect(session.recoveryCodes).toHaveLength(10);
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${session.token}` },
    });
    expect(me.json<{ twoFactor: boolean }>().twoFactor).toBe(true);
    // Taken: the challenge works once.
    expect((await setupCall('POST', '/me/two-factor/totp', {})).statusCode).toBe(401);
    expect(events.find((e) => e.action === 'auth.signed_in')?.details).toMatchObject({ secondFactor: 'totp' });
  });

  it('an admin reset removes every method and ends every session', async () => {
    const admin = await signedInUser(h, { email: 'root@example.com', password: PASSWORD, serverAdmin: true });
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const other = await signedInUser(h, { email: 'alice2@example.com', password: PASSWORD });
    await enrol(alice);
    const ended: SessionEnded[] = [];
    h.hooks.sessionEnded.push(
      local((event) => {
        ended.push(event);
      }),
    );
    expect((await call(alice, 'DELETE', `/users/${alice.user.id}/two-factor`)).statusCode).toBe(403);
    const twoFactorOf = async () =>
      (await call(admin, 'GET', '/users'))
        .json<{ id: string; twoFactor: boolean }[]>()
        .find((u) => u.id === alice.user.id)?.twoFactor;
    expect(await twoFactorOf()).toBe(true);
    expect((await call(admin, 'DELETE', `/users/${alice.user.id}/two-factor`)).statusCode).toBe(204);
    expect((await call(alice, 'GET', '/me')).statusCode).toBe(401);
    expect((await call(other, 'GET', '/me')).statusCode).toBe(200);
    expect(ended).toEqual([{ tenantId: h.tdb.scope.tenantId, userId: alice.user.id }]);
    expect(await twoFactorOf()).toBe(false);
    expect((await call(admin, 'DELETE', '/users/nobody/two-factor')).statusCode).toBe(404);
  });

  it('records each change with the method and no secret', async () => {
    const admin = await signedInUser(h, { email: 'root@example.com', password: PASSWORD, serverAdmin: true });
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const { recoveryCodes, key } = await enrol(alice);
    const made = await call(alice, 'POST', '/me/two-factor/recovery-codes', { password: PASSWORD });
    await call(alice, 'DELETE', '/me/two-factor/totp', { password: PASSWORD });
    await enrol(alice);
    await call(admin, 'DELETE', `/users/${alice.user.id}/two-factor`);
    expect(events.map((e) => e.action)).toEqual([
      'user.two_factor_method_added',
      'user.two_factor_enabled',
      'user.recovery_codes_regenerated',
      'user.two_factor_method_removed',
      'user.two_factor_disabled',
      'user.two_factor_method_added',
      'user.two_factor_enabled',
      'user.two_factor_reset',
    ]);
    for (const event of events) expect(event.target).toEqual({ kind: 'user', id: alice.user.id });
    expect(events[0]!.details).toEqual({ method: 'totp' });
    const logged = JSON.stringify(events);
    for (const secret of [...recoveryCodes, ...made.json<{ recoveryCodes: string[] }>().recoveryCodes, PASSWORD])
      expect(logged).not.toContain(secret);
    expect(logged).not.toContain(key.toString('hex'));
  });
});
