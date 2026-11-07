/**
 * Accepting an invitation in the browser (team management in the browser §2.3): the invitation page's
 * browser variant, and its form at `POST /invite/:secret`, which runs the desktop accept's claim and
 * signs the browser in.
 */
import { afterEach, describe, expect, it, vi } from 'vitest';
import type { OidcProvider } from '../../../src/identity/oidc.js';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret } from '../../../src/identity/tokens.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import {
  OIDC_ENV,
  identityHarness,
  signedInUser,
  type IdentityHarness,
  type SignedInUser,
} from '../../helpers/identity.js';

const PUBLIC_URL = 'https://wirebench.test';
const COOKIE = '__Host-wb_session';
const FORM_CSP = "default-src 'none'; style-src 'unsafe-inline'; form-action 'self'; frame-ancestors 'none'";
const BROWSER_ENV = {
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const PASSWORD = 'correct horse battery';
const DAY = 24 * 60 * 60 * 1000;

/** Never reached: the page only needs OIDC to be configured. */
const stubProvider: OidcProvider = {
  issuer: 'https://idp.test',
  authorizationUrl: () => 'https://idp.test/authorize',
  exchange: () => Promise.reject(new Error('not used')),
};

type Injected = Awaited<ReturnType<IdentityHarness['app']['inject']>>;
const sessionFrom = (res: Injected): string | undefined => {
  const header = res.headers['set-cookie'];
  const lines = header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
  return lines
    .find((line) => line.startsWith(`${COOKIE}=`))
    ?.slice(COOKIE.length + 1)
    .split(';')[0];
};
const secretOf = (url: string) => url.slice(url.lastIndexOf('/') + 1);

describeDb('accepting an invitation in the browser (team management in the browser §2.3)', () => {
  let h: IdentityHarness;
  let admin: SignedInUser;
  afterEach(() => h.close());

  const start = async (env: Record<string, string> = BROWSER_ENV, provider?: OidcProvider) => {
    h = await identityHarness({ env, ...(provider !== undefined ? { provider } : {}) });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
  };
  const invite = async (email = 'bob@example.com') => {
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/invitations',
      headers: admin.headers,
      payload: { email },
    });
    expect(res.statusCode, res.body).toBe(201);
    return secretOf(res.json<{ url: string }>().url);
  };
  const page = (secret: string, ip = '10.0.1.1') =>
    h.app.inject({ method: 'GET', url: `/invite/${secret}`, remoteAddress: ip });
  /** `origin: null` sends no Origin header at all. */
  const post = (secret: string, fields: Record<string, string>, origin: string | null = PUBLIC_URL, ip = '10.0.2.1') =>
    h.app.inject({
      method: 'POST',
      url: `/invite/${secret}`,
      headers: { 'content-type': 'application/x-www-form-urlencoded', ...(origin !== null ? { origin } : {}) },
      payload: new URLSearchParams(fields).toString(),
      remoteAddress: ip,
    });

  describe('the page', () => {
    it('offers the form, the desktop steps as the other way in, under the form policy', async () => {
      await start();
      const secret = await invite();
      const res = await page(secret);
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-security-policy']).toBe(FORM_CSP);
      // Not no-referrer: under it a browser posts the form with `Origin: null`, which the form refuses.
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.body).toContain(`action="/invite/${secret}"`);
      expect(res.body).toContain('name="password"');
      expect(res.body).toContain('name="confirm"');
      expect(res.body).toContain('name="displayName"');
      expect(res.body).toContain('Or use the desktop app');
      expect(res.body).not.toContain('<script');
      expect(res.body).not.toContain('/sign-in/oidc');
    });

    it('lists OIDC under its escaped name, and drops the form when local sign-in is off', async () => {
      await start(
        {
          ...BROWSER_ENV,
          ...OIDC_ENV,
          WIREBENCH_SERVER_LOCAL_AUTH: 'false',
          WIREBENCH_SERVER_OIDC_DISPLAY_NAME: '<b>Corp</b>',
        },
        stubProvider,
      );
      const secret = await invite();
      const res = await page(secret);
      expect(res.body).toContain('href="/sign-in/oidc"');
      expect(res.body).toContain('Continue with &lt;b&gt;Corp&lt;/b&gt;');
      expect(res.body).not.toContain('<form');
    });

    it('shows the closed page for an unknown secret', async () => {
      await start();
      const res = await page(mintSecret().secret);
      expect(res.body).toContain('This invitation has expired or was already used.');
      expect(res.body).not.toContain('<form');
    });
  });

  describe('POST /invite/:secret', () => {
    it('creates the account, runs the accept hooks, signs the browser in and lands on /', async () => {
      await start();
      const accepted = vi.fn();
      h.hooks.invitationAccepted.push((_tx, event) => {
        accepted(event);
        return Promise.resolve();
      });
      const events = recordingAudit(h.hooks);
      const secret = await invite();
      const res = await post(secret, { displayName: ' Bob B ', password: PASSWORD, confirm: PASSWORD });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers['location']).toBe('/');
      const user = await repo.findUserByEmail(h.tdb, 'bob@example.com');
      expect(user).toMatchObject({ displayName: 'Bob B', serverAdmin: false });
      expect(accepted).toHaveBeenCalledWith(expect.objectContaining({ userId: user!.id }));
      const tokens = await repo.tokensOfUser(h.tdb, user!.id);
      expect(tokens.map((t) => t.kind)).toEqual(['browser']);
      const me = await h.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { cookie: `${COOKIE}=${sessionFrom(res)!}` },
      });
      expect(me.statusCode).toBe(200);
      expect(events.map((e) => e.action)).toEqual(expect.arrayContaining(['user.created', 'auth.signed_in']));
      // Used: the page and the form now answer closed, and the desktop's accept is refused too.
      expect((await page(secret)).body).toContain('This invitation has expired or was already used.');
      const again = await post(secret, { password: PASSWORD, confirm: PASSWORD });
      expect(again.statusCode).toBe(404);
      expect(again.body).toContain('This invitation has expired or was already used.');
      expect(sessionFrom(again)).toBeUndefined();
      const desktop = await h.app.inject({
        method: 'POST',
        url: '/api/v1/invitations/accept',
        payload: { secret, displayName: 'Bob', password: PASSWORD, device: { name: 'Mac' } },
      });
      expect(desktop.statusCode).toBe(404);
    });

    it('takes the invited email’s first part as the name when none is typed', async () => {
      await start();
      const secret = await invite('carol@example.com');
      expect((await post(secret, { password: PASSWORD, confirm: PASSWORD })).statusCode).toBe(303);
      expect(await repo.findUserByEmail(h.tdb, 'carol@example.com')).toMatchObject({ displayName: 'carol' });
    });

    it('sets a new password from a reset and signs the browser in with it', async () => {
      await start();
      const member = await signedInUser(h, { email: 'dave@example.com', password: 'an old password!' });
      const reset = await h.app.inject({
        method: 'POST',
        url: `/api/v1/users/${member.user.id}/password-reset`,
        headers: admin.headers,
      });
      expect(reset.statusCode, reset.body).toBe(201);
      const secret = secretOf(reset.json<{ url: string }>().url);
      const shown = await page(secret);
      expect(shown.body).toContain('Set a new password');
      expect(shown.body).not.toContain('name="displayName"');
      const res = await post(secret, { password: PASSWORD, confirm: PASSWORD });
      expect(res.statusCode, res.body).toBe(303);
      // The reset revoked the desktop's token; the browser holds the only live one.
      const tokens = (await repo.tokensOfUser(h.tdb, member.user.id)).filter((t) => t.revokedAt === null);
      expect(tokens.map((t) => t.kind)).toEqual(['browser']);
    });

    it('refuses an expired invitation with the closed page and creates nothing', async () => {
      await start();
      const secret = await invite();
      h.clock.advance(8 * DAY);
      const res = await post(secret, { password: PASSWORD, confirm: PASSWORD });
      expect(res.statusCode).toBe(404);
      expect(res.body).toContain('This invitation has expired or was already used.');
      expect(await repo.findUserByEmail(h.tdb, 'bob@example.com')).toBeUndefined();
    });

    it('refuses a wrong or missing Origin before touching the invitation', async () => {
      await start();
      const secret = await invite();
      for (const origin of ['https://evil.test', 'null', null]) {
        const res = await post(secret, { password: PASSWORD, confirm: PASSWORD }, origin);
        expect(res.statusCode).toBe(403);
        expect(res.json<{ code: string }>().code).toBe('identity-origin-refused');
        expect(sessionFrom(res)).toBeUndefined();
      }
      expect(await repo.findUserByEmail(h.tdb, 'bob@example.com')).toBeUndefined();
      // Still open: the person can accept from the real page.
      expect((await post(secret, { password: PASSWORD, confirm: PASSWORD })).statusCode).toBe(303);
    });

    it('shows the page again for mismatched or short passwords, keeping the typed name, and the invitation open', async () => {
      await start();
      const secret = await invite();
      const mismatch = await post(secret, { displayName: 'Bob <b>', password: PASSWORD, confirm: `${PASSWORD}!` });
      expect(mismatch.statusCode).toBe(400);
      expect(mismatch.body).toContain('The two passwords do not match.');
      expect(mismatch.body).toContain('value="Bob &lt;b&gt;"');
      expect(mismatch.headers['content-security-policy']).toBe(FORM_CSP);
      const short = await post(secret, { password: 'short', confirm: 'short' });
      expect(short.statusCode).toBe(400);
      expect(short.body).toContain('Passwords must be at least 12 characters long.');
      expect(await repo.findUserByEmail(h.tdb, 'bob@example.com')).toBeUndefined();
      expect((await post(secret, { password: PASSWORD, confirm: PASSWORD })).statusCode).toBe(303);
    });

    it('is rate-limited per address', async () => {
      await start();
      const secret = mintSecret().secret;
      for (let i = 0; i < 10; i += 1)
        await post(secret, { password: PASSWORD, confirm: PASSWORD }, PUBLIC_URL, '10.0.3.1');
      expect((await post(secret, { password: PASSWORD, confirm: PASSWORD }, PUBLIC_URL, '10.0.3.1')).statusCode).toBe(
        429,
      );
      expect((await post(secret, { password: PASSWORD, confirm: PASSWORD }, PUBLIC_URL, '10.0.3.2')).statusCode).toBe(
        404,
      );
    });
  });
});
