import { afterEach, beforeEach, expect, it } from 'vitest';
import { DEVICE_TOKEN_PATTERN } from '@wirebench/engine';
import { mintSecret, pkceChallenge } from '../../../src/identity/tokens.js';
import { sealTotpSecret } from '../../../src/identity/two-factor/keys.js';
import { renderTwoFactorPage, TWO_FACTOR_PAGE_CSP } from '../../../src/identity/two-factor/page.js';
import * as tf from '../../../src/identity/two-factor/repo.js';
import { newTotpSecret, stepAt, totpAt } from '../../../src/identity/two-factor/totp.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { SoftAuthenticator } from '../../helpers/soft-authenticator.js';

const PASSWORD = 'correct horse battery';
const KEY_ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };
const ORIGIN = 'https://wirebench.test';
const RP_ID = 'wirebench.test';
const CHALLENGE_COOKIE = '__Host-wb_2fa';
const SESSION_COOKIE = '__Host-wb_session';

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

it('on another host than the primary, the page offers codes and links to the primary for passkeys', () => {
  const html = renderTwoFactorPage({
    serverUrl: 'https://acme.example.test',
    methods: ['passkey', 'totp', 'recovery'],
    setup: false,
    redirectTo: '/',
    passkeyAt: 'https://wirebench.acme.example',
  });
  expect(html).toContain('To use a passkey, sign in at <a href="https://wirebench.acme.example/sign-in">');
  expect(html).not.toContain('id="passkey"');
  expect(html).not.toContain('<script');
  expect(html).toContain('name="code"');
});

describeDb('two-step sign-in, the browser page and the desktop hand-off (spec §4.1, §4.2)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness({ env: KEY_ENV });
  });
  afterEach(() => h.close());

  const form = (url: string, fields: Record<string, string>, cookie?: string, origin = ORIGIN) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        origin,
        ...(cookie !== undefined ? { cookie } : {}),
      },
      payload: new URLSearchParams(fields).toString(),
    });
  const script = (url: string, payload: object, cookie?: string) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: { origin: ORIGIN, ...(cookie !== undefined ? { cookie } : {}) },
      payload,
    });
  const api = (url: string, payload: object) => h.app.inject({ method: 'POST', url: `/api/v1${url}`, payload });

  const withTotp = async (user: SignedInUser) => {
    const dataKey = await h.ctx.tenancy.dataKey(h.tdb.scope);
    const secret = newTotpSecret();
    await tf.upsertPendingTotp(h.tdb, user.user.id, sealTotpSecret(dataKey, user.user.id, secret), h.clock.now);
    await tf.confirmTotp(h.tdb, user.user.id, stepAt(h.clock.now.getTime()) - 2, h.clock.now);
    return () => totpAt(secret, stepAt(h.clock.now.getTime()));
  };
  const withPasskey = async (user: SignedInUser) => {
    const key = new SoftAuthenticator(RP_ID, ORIGIN);
    await tf.insertPasskey(h.tdb, {
      id: `pk-${user.user.id}`,
      userId: user.user.id,
      credentialId: key.credentialId,
      publicKey: key.publicKey,
      counter: 0,
      transports: ['internal'],
      name: 'Laptop',
      at: h.clock.now,
    });
    return key;
  };
  const passwordForm = (fields: Record<string, string> = {}) =>
    form('/sign-in/local', { email: 'alice@example.com', password: PASSWORD, ...fields });
  /** The desktop's password step and passkey hand-off up to the grant its loopback gets. */
  const handOff = async (key: SoftAuthenticator) => {
    const signIn = await api('/auth/local/sign-in', {
      email: 'alice@example.com',
      password: PASSWORD,
      device: { name: 'Alice’s Mac' },
    });
    const challenge = signIn.json<{ twoFactor: { challenge: string } }>().twoFactor.challenge;
    const verifier = mintSecret().secret;
    const started = await api('/auth/two-factor/passkey/browser-start', {
      challenge,
      codeChallenge: pkceChallenge(verifier),
      loopbackPort: 49152,
    });
    expect(started.statusCode, started.body).toBe(200);
    const url = new URL(started.json<{ url: string }>().url);
    const flow = url.searchParams.get('flow')!;
    const options = await script(`/sign-in/two-factor/passkey/options?flow=${flow}`, {});
    expect(options.statusCode, options.body).toBe(200);
    const handed = await script(`/sign-in/two-factor/passkey/verify?flow=${flow}`, {
      response: key.get(options.json<{ challenge: string }>()),
    });
    expect(handed.statusCode, handed.body).toBe(200);
    const loopback = new URL(handed.json<{ location: string }>().location);
    return { challenge, url, flow, verifier, handed, loopback, grant: loopback.searchParams.get('grant')! };
  };

  it('the page lists only the person’s methods and escapes every value', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    await withTotp(alice);
    const codes = await passwordForm({ redirect_to: '/w/1?tab="<b>"' });
    expect(codes.statusCode).toBe(200);
    expect(codes.body).toContain('Two-step sign-in');
    expect(codes.body).toContain('autocomplete="one-time-code"');
    expect(codes.body).not.toContain('id="passkey"');
    expect(codes.body).not.toContain('<script');
    expect(codes.body).not.toContain('<b>');
    expect(codes.body).toContain('action="/sign-in/two-factor/cancel"');

    await withPasskey(alice);
    const both = await passwordForm();
    expect(both.body).toContain('id="passkey"');
    expect(both.body).toContain('<script src="/sign-in/two-factor.js"></script>');
  });

  it('the page’s CSP allows the served script and nothing else', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    await withPasskey(alice);
    const page = await passwordForm();
    expect(page.headers['content-security-policy']).toBe(TWO_FACTOR_PAGE_CSP);
    expect(/script-src [^;]+/.exec(TWO_FACTOR_PAGE_CSP)?.[0]).toBe("script-src 'self'");
    expect(/connect-src [^;]+/.exec(TWO_FACTOR_PAGE_CSP)?.[0]).toBe("connect-src 'self'");
    const served = await h.app.inject({ method: 'GET', url: '/sign-in/two-factor.js' });
    expect(served.statusCode).toBe(200);
    expect(served.headers['content-type']).toContain('text/javascript');
    expect(served.headers['x-content-type-options']).toBe('nosniff');
    expect(served.body).toContain('navigator.credentials.get');
  });

  it('counts attempts down on the page, and cancel drops the challenge', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const code = await withTotp(alice);
    const first = await passwordForm();
    const cookie = `${CHALLENGE_COOKIE}=${cookieFrom(first, CHALLENGE_COOKIE)!}`;
    for (const left of [undefined, undefined, '2 attempts left.', '1 attempt left.']) {
      const wrong = await form('/sign-in/two-factor', { method: 'totp', code: '000000' }, cookie);
      expect(wrong.statusCode).toBe(401);
      if (left !== undefined) expect(wrong.body).toContain(left);
      else expect(wrong.body).not.toContain('left.');
    }
    // The fifth ends it: back to the sign-in page.
    const fifth = await form('/sign-in/two-factor', { method: 'totp', code: '000000' }, cookie);
    expect(fifth.body).toContain('action="/sign-in/local"');
    expect(fifth.body).toContain('Sign in again');

    const second = await passwordForm();
    const again = `${CHALLENGE_COOKIE}=${cookieFrom(second, CHALLENGE_COOKIE)!}`;
    expect((await form('/sign-in/two-factor/cancel', {}, again, 'https://evil.test')).statusCode).toBe(403);
    const cancelled = await form('/sign-in/two-factor/cancel', {}, again);
    expect(cancelled.statusCode).toBe(303);
    expect(cancelled.headers.location).toBe('/sign-in');
    expect(setCookies(cancelled).find((l) => l.startsWith(`${CHALLENGE_COOKIE}=`))).toContain('Max-Age=0');
    const after = await form('/sign-in/two-factor', { method: 'totp', code: code() }, again);
    expect(after.body).toContain('action="/sign-in/local"');
  });

  it('a passkey on the page signs the browser in', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const key = await withPasskey(alice);
    const page = await passwordForm();
    const cookie = `${CHALLENGE_COOKIE}=${cookieFrom(page, CHALLENGE_COOKIE)!}`;
    // The script's calls are bound to the cookie.
    expect((await script('/sign-in/two-factor/passkey/options', {})).statusCode).toBe(401);
    const options = await script('/sign-in/two-factor/passkey/options', {}, cookie);
    expect(options.statusCode, options.body).toBe(200);
    const done = await script(
      '/sign-in/two-factor/passkey/verify',
      { redirectTo: '/w/2', response: key.get(options.json<{ challenge: string }>()) },
      cookie,
    );
    expect(done.statusCode, done.body).toBe(200);
    expect(done.json<{ location: string }>().location).toBe('/w/2');
    expect(cookieFrom(done, SESSION_COOKIE)).toMatch(DEVICE_TOKEN_PATTERN);
  });

  it('the desktop flow: browser-start, the passkey on the page, the grant to the loopback, complete with the verifier', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const key = await withPasskey(alice);
    const run = await handOff(key);
    expect(run.url.origin).toBe(ORIGIN);
    expect(run.url.pathname).toBe('/sign-in/two-factor/passkey');
    // The challenge's secret never goes to the browser: only the flow and the grant do.
    expect(run.url.href).not.toContain(run.challenge);
    const page = await h.app.inject({ method: 'GET', url: `${run.url.pathname}${run.url.search}` });
    // Taken by the grant: the page no longer offers the flow.
    expect(page.body).toContain('Start again from Wirebench');
    // No browser session for the desktop's sign-in.
    expect(cookieFrom(run.handed, SESSION_COOKIE)).toBeUndefined();
    expect(run.loopback.origin).toBe('http://127.0.0.1:49152');
    expect(run.loopback.pathname).toBe('/callback');
    expect(run.loopback.searchParams.get('flow')).toBe(run.flow);
    // One hand-off per challenge.
    const second = await api('/auth/two-factor/passkey/browser-start', {
      challenge: run.challenge,
      codeChallenge: pkceChallenge(run.verifier),
      loopbackPort: 49153,
    });
    expect(codeOf(second)).toBe('identity-flow-invalid');

    const done = await api('/auth/two-factor/passkey/complete', {
      flowId: run.flow,
      grant: run.grant,
      codeVerifier: run.verifier,
    });
    expect(done.statusCode, done.body).toBe(201);
    expect(done.json<{ token: string }>().token).toMatch(DEVICE_TOKEN_PATTERN);
    const tokens = await h.tdb.query<{ device_name: string }>(
      'select device_name from device_tokens where user_id = $1',
      [alice.user.id],
    );
    expect(tokens.rows.map((row) => row.device_name)).toContain('Alice’s Mac');
  });

  it('the flow page runs the passkey for a live flow only', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    await withPasskey(alice);
    const signIn = await api('/auth/local/sign-in', {
      email: 'alice@example.com',
      password: PASSWORD,
      device: { name: 'Mac' },
    });
    const challenge = signIn.json<{ twoFactor: { challenge: string } }>().twoFactor.challenge;
    const started = await api('/auth/two-factor/passkey/browser-start', {
      challenge,
      codeChallenge: pkceChallenge(mintSecret().secret),
      loopbackPort: 49152,
    });
    const url = new URL(started.json<{ url: string }>().url);
    const flow = url.searchParams.get('flow')!;
    const page = await h.app.inject({ method: 'GET', url: `${url.pathname}${url.search}` });
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain(`data-flow="${flow}"`);
    expect(page.body).not.toContain('name="code"');
    expect(page.body).toContain('<script src="/sign-in/two-factor.js"></script>');
    const unknown = await h.app.inject({ method: 'GET', url: '/sign-in/two-factor/passkey?flow=nope' });
    expect(unknown.body).toContain('Start again from Wirebench');
  });

  it('complete refuses a wrong verifier, a used grant and an expired flow', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const key = await withPasskey(alice);
    const one = await handOff(key);
    const complete = (run: { flow: string; grant: string }, codeVerifier: string) =>
      api('/auth/two-factor/passkey/complete', { flowId: run.flow, grant: run.grant, codeVerifier });
    expect(codeOf(await complete(one, mintSecret().secret))).toBe('identity-flow-invalid');
    expect((await complete(one, one.verifier)).statusCode).toBe(201);
    expect(codeOf(await complete(one, one.verifier))).toBe('identity-flow-invalid');

    const two = await handOff(key);
    h.clock.advance(5 * 60_000 + 1);
    expect(codeOf(await complete(two, two.verifier))).toBe('identity-flow-invalid');
  });

  // Switch accounts spec §5.3 through the second step: *Add an account* keeps the session the browser held.
  const ACCOUNTS_COOKIE = '__Host-wb_accounts';
  const addForm = (cookie: string) =>
    form('/sign-in/local', { identifier: 'alice@example.com', password: PASSWORD, add: '1' }, cookie);

  it('Add an account with a second step keeps the old session, by code and by passkey', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', kind: 'browser' });
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const code = await withTotp(alice);
    const key = await withPasskey(alice);
    const held = `${SESSION_COOKIE}=${bob.token}`;

    const page = await addForm(held);
    expect(page.statusCode).toBe(200);
    expect(page.body).toContain('<input type="hidden" name="add" value="1">');
    expect(page.body).toContain('data-add="1"');
    const challenge = `${CHALLENGE_COOKIE}=${cookieFrom(page, CHALLENGE_COOKIE)!}`;
    const done = await form('/sign-in/two-factor', { method: 'totp', code: code(), add: '1' }, `${held}; ${challenge}`);
    expect(done.statusCode, done.body).toBe(303);
    expect(cookieFrom(done, SESSION_COOKIE)).toMatch(DEVICE_TOKEN_PATTERN);
    expect(cookieFrom(done, ACCOUNTS_COOKIE)).toBe(bob.token);
    const bobStill = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${bob.token}` },
    });
    expect(bobStill.statusCode).toBe(200);

    const second = await addForm(held);
    const cookie = `${held}; ${CHALLENGE_COOKIE}=${cookieFrom(second, CHALLENGE_COOKIE)!}`;
    const options = await script('/sign-in/two-factor/passkey/options', {}, cookie);
    const byKey = await script(
      '/sign-in/two-factor/passkey/verify',
      { add: true, response: key.get(options.json<{ challenge: string }>()) },
      cookie,
    );
    expect(byKey.statusCode, byKey.body).toBe(200);
    expect(cookieFrom(byKey, ACCOUNTS_COOKIE)).toBe(bob.token);
  });

  it('a sixth account is refused at the second step before the code is spent', async () => {
    const held = await Promise.all(
      ['a', 'b', 'c', 'd', 'e'].map((name) => signedInUser(h, { email: `${name}@example.com`, kind: 'browser' })),
    );
    const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const code = await withTotp(alice);
    const sessions = `${SESSION_COOKIE}=${held[0]!.token}; ${ACCOUNTS_COOKIE}=${held
      .slice(1)
      .map((one) => one.token)
      .join(' ')}`;
    // The password leads to the second step; the refusal comes there, before the code is checked.
    const page = await addForm(sessions);
    expect(page.statusCode).toBe(200);
    const challenge = `${CHALLENGE_COOKIE}=${cookieFrom(page, CHALLENGE_COOKIE)!}`;
    const full = await form(
      '/sign-in/two-factor',
      { method: 'totp', code: code(), add: '1' },
      `${sessions}; ${challenge}`,
    );
    expect(full.statusCode).toBe(409);
    expect(full.body).toContain('This browser already holds five accounts.');
    expect(cookieFrom(full, SESSION_COOKIE)).toBeUndefined();
    // The code was not spent: the same challenge still finishes once there is room.
    const room = await form(
      '/sign-in/two-factor',
      { method: 'totp', code: code(), add: '1' },
      `${SESSION_COOKIE}=${held[0]!.token}; ${challenge}`,
    );
    expect(room.statusCode, room.body).toBe(303);
  });
});
