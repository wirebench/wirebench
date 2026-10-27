import { afterEach, describe, expect, it } from 'vitest';
import type { OidcProvider } from '../../../src/identity/oidc.js';
import * as repo from '../../../src/identity/repo.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { OIDC_ENV, identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PUBLIC_URL = 'https://wirebench.test';
const COOKIE = '__Host-wb_session';
const CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
const BROWSER_ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const PASSWORD = 'correct horse battery';

/** Never reached by these tests: the page only needs OIDC to be configured. */
const stubProvider: OidcProvider = {
  issuer: 'https://idp.test',
  authorizationUrl: () => 'https://idp.test/authorize',
  exchange: () => Promise.reject(new Error('not used')),
};

type Injected = Awaited<ReturnType<IdentityHarness['app']['inject']>>;
const setCookies = (res: Injected): string[] => {
  const header = res.headers['set-cookie'];
  return header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
};
const sessionFrom = (res: Injected): string | undefined =>
  setCookies(res)
    .find((line) => line.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
    .split(';')[0];

describeDb('the sign-in page and local form sign-in (hosted spec §17.2)', () => {
  let h: IdentityHarness;
  afterEach(() => h.close());

  /** `origin: null` sends no Origin header at all. */
  const signInForm = (fields: Record<string, string>, origin: string | null = PUBLIC_URL, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'POST',
      url: '/sign-in/local',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(origin !== null ? { origin } : {}),
      },
      payload: new URLSearchParams(fields).toString(),
      remoteAddress: ip,
    });

  describe('with the browser client off', () => {
    it('serves none of the routes', async () => {
      h = await identityHarness();
      expect((await h.app.inject({ method: 'GET', url: '/sign-in' })).statusCode).toBe(404);
      expect((await signInForm({ email: 'a@example.com', password: PASSWORD })).statusCode).toBe(404);
      expect((await h.app.inject({ method: 'GET', url: '/sign-in/oidc' })).statusCode).toBe(404);
    });
  });

  describe('the page', () => {
    it('offers the local form only when local is the only method, under the page CSP', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      const res = await h.app.inject({ method: 'GET', url: '/sign-in' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
      expect(res.headers['content-security-policy']).toBe(CSP);
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain('action="/sign-in/local"');
      expect(res.body).toContain('name="email"');
      expect(res.body).toContain('name="password"');
      expect(res.body).not.toContain('/sign-in/oidc');
      expect(res.body).not.toContain('/sign-in/saml');
      expect(res.body).not.toContain('<script');
    });

    it('lists OIDC under its escaped display name, and drops the form when local is off', async () => {
      h = await identityHarness({
        env: {
          ...BROWSER_ENV,
          ...OIDC_ENV,
          WIREBENCH_SERVER_LOCAL_AUTH: 'false',
          WIREBENCH_SERVER_OIDC_DISPLAY_NAME: '<script>alert(1)</script> & Co',
        },
        provider: stubProvider,
      });
      const res = await h.app.inject({ method: 'GET', url: '/sign-in' });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('href="/sign-in/oidc"');
      expect(res.body).toContain('&lt;script&gt;alert(1)&lt;/script&gt; &amp; Co');
      expect(res.body).not.toContain('<script>');
      expect(res.body).not.toContain('/sign-in/local');
      expect(res.body).not.toContain('/sign-in/saml');
    });

    it('carries a same-origin redirect_to into the form and the OIDC link, and drops a foreign one', async () => {
      h = await identityHarness({ env: { ...BROWSER_ENV, ...OIDC_ENV }, provider: stubProvider });
      const kept = await h.app.inject({ method: 'GET', url: '/sign-in?redirect_to=%2Fw%2F1%3Ftab%3Da%26b%3D%22' });
      expect(kept.body).toContain('name="redirect_to" value="/w/1?tab=a&amp;b=%22"');
      expect(kept.body).toContain('href="/sign-in/oidc?redirect_to=%2Fw%2F1%3Ftab%3Da%26b%3D%2522"');
      const dropped = await h.app.inject({ method: 'GET', url: '/sign-in?redirect_to=https%3A%2F%2Fevil.test%2F' });
      expect(dropped.body).not.toContain('evil.test');
      expect(dropped.body).toContain('href="/sign-in/oidc"');
    });
  });

  describe('POST /sign-in/local', () => {
    it('signs in with a browser token, sets the cookie for the token’s maximum age and redirects to /', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      const alice = await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
      const events = recordingAudit(h.hooks);
      const res = await signInForm({ email: 'Alice@Example.com', password: PASSWORD });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers['location']).toBe('/');
      const line = setCookies(res).find((l) => l.startsWith(`${COOKIE}=`))!;
      // The default WIREBENCH_SERVER_TOKEN_MAX_DAYS is 180.
      expect(line).toContain(`Max-Age=${180 * 24 * 60 * 60}`);
      expect(line).toContain('HttpOnly');
      expect(line).toContain('Secure');
      expect(line).toContain('SameSite=Lax');
      const token = sessionFrom(res)!;
      const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `${COOKIE}=${token}` } });
      expect(me.statusCode).toBe(200);
      const tokens = await repo.tokensOfUser(h.db, alice.user.id);
      expect(tokens.map((t) => t.kind).sort()).toEqual(['browser', 'device']);
      expect(events.filter((e) => e.action === 'auth.signed_in').map((e) => e.details?.['method'])).toEqual(['local']);
    });

    it('lands on a same-origin redirect_to, and on / for a foreign or protocol-relative one', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
      const to = async (redirectTo: string) =>
        (await signInForm({ email: 'alice@example.com', password: PASSWORD, redirect_to: redirectTo })).headers[
          'location'
        ];
      expect(await to('/w/1?tab=a')).toBe('/w/1?tab=a');
      for (const evil of ['https://evil.test/', '//evil.test/x', '/\\evil.test', 'javascript:alert(1)', 'w/1', ''])
        expect(await to(evil)).toBe('/');
    });

    it('answers a wrong password and an unknown email with the same page, status and no cookie', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
      const events = recordingAudit(h.hooks);
      const wrong = await signInForm({ email: 'alice@example.com', password: 'not the password' });
      const unknown = await signInForm({ email: 'nobody@example.com', password: 'not the password' });
      expect(wrong.statusCode).toBe(401);
      expect(unknown.statusCode).toBe(401);
      expect(wrong.body).toBe(unknown.body);
      expect(wrong.body).toContain('The email or password is not right.');
      expect(wrong.headers['content-security-policy']).toBe(CSP);
      expect(sessionFrom(wrong)).toBeUndefined();
      expect(sessionFrom(unknown)).toBeUndefined();
      expect(events.filter((e) => e.action === 'auth.sign_in_failed').map((e) => e.details?.['reason'])).toEqual([
        'identity-invalid-credentials',
        'identity-invalid-credentials',
      ]);
    });

    it('refuses a disabled account without a cookie', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      await signedInUser(h, { email: 'off@example.com', password: PASSWORD, disabled: true });
      const res = await signInForm({ email: 'off@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('This account is disabled.');
      expect(sessionFrom(res)).toBeUndefined();
    });

    it('refuses a form posted from another origin or with no Origin (login CSRF)', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
      for (const origin of ['https://evil.test', 'null', null]) {
        const res = await signInForm({ email: 'alice@example.com', password: PASSWORD }, origin);
        expect(res.statusCode).toBe(403);
        expect(res.json<{ code: string }>().code).toBe('identity-origin-refused');
        expect(sessionFrom(res)).toBeUndefined();
      }
    });

    it('shares the desktop route’s rate limit per address', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      for (let i = 0; i < 10; i += 1)
        expect((await signInForm({ email: `x${i}@example.com`, password: 'nope nope nope' })).statusCode).toBe(401);
      const limited = await signInForm({ email: 'y@example.com', password: 'nope nope nope' });
      expect(limited.statusCode).toBe(429);
      expect(limited.headers['retry-after']).toBeDefined();
      expect(limited.body).toContain('Too many attempts');
    });

    it('answers 400 with the page for a form missing a field', async () => {
      h = await identityHarness({ env: BROWSER_ENV });
      const res = await signInForm({ email: 'alice@example.com' });
      expect(res.statusCode).toBe(400);
      expect(res.headers['content-type']).toMatch(/^text\/html/);
    });

    it('is 404 when local sign-in is off', async () => {
      h = await identityHarness({
        env: { ...BROWSER_ENV, ...OIDC_ENV, WIREBENCH_SERVER_LOCAL_AUTH: 'false' },
        provider: stubProvider,
      });
      const res = await signInForm({ email: 'alice@example.com', password: PASSWORD });
      expect(res.statusCode).toBe(404);
    });
  });

  it('the cookie is wb_session without Secure on an http public URL', async () => {
    h = await identityHarness({
      env: {
        ...BROWSER_ENV,
        WIREBENCH_SERVER_PUBLIC_URL: 'http://wirebench.test',
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
    await signedInUser(h, { email: 'alice@example.com', password: PASSWORD });
    const res = await signInForm({ email: 'alice@example.com', password: PASSWORD }, 'http://wirebench.test');
    expect(res.statusCode).toBe(303);
    const line = setCookies(res).find((l) => l.startsWith('wb_session='))!;
    expect(line).not.toContain('Secure');
  });
});
