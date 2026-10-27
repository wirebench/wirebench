import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { hashSecret } from '../../../src/identity/tokens.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { EVIL_REDIRECTS, identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const COOKIE = '__Host-wb_session';
const FLOW_COOKIE = '__Host-wb_flow';
const BROWSER_ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};

type Injected = Awaited<ReturnType<IdentityHarness['app']['inject']>>;
const setCookies = (res: Injected): string[] => {
  const header = res.headers['set-cookie'];
  return header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
};
const cookieValue = (res: Injected, name: string): string | undefined =>
  setCookies(res)
    .find((line) => line.startsWith(`${name}=`))
    ?.slice(name.length + 1)
    .split(';')[0];

describeDb('OIDC sign-in from the browser (hosted spec §17.2)', () => {
  let idp: FakeOidcIssuer;
  let h: IdentityHarness;
  const boot = async (browserClient = true) => {
    idp = await startFakeOidcIssuer();
    h = await identityHarness({
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        ...(browserClient ? BROWSER_ENV : {}),
      },
    });
  };
  afterEach(async () => {
    await h.close();
    await idp.close();
  });

  /** `GET /sign-in/oidc`, answering the redirect, the IdP's URL and the flow cookie. */
  const start = async (query = '', remoteAddress = '127.0.0.1') => {
    const res = await h.app.inject({ method: 'GET', url: `/sign-in/oidc${query}`, remoteAddress });
    expect(res.statusCode, res.body).toBe(302);
    return { res, authorizationUrl: String(res.headers['location']), flowCookie: cookieValue(res, FLOW_COOKIE)! };
  };
  /** The browser comes back from the IdP to the callback, carrying `cookie`. */
  const callback = (back: URL, cookie: string | undefined, remoteAddress = '127.0.0.1') =>
    h.app.inject({
      method: 'GET',
      url: `${back.pathname}${back.search}`,
      remoteAddress,
      headers: cookie === undefined ? {} : { cookie: `${FLOW_COOKIE}=${cookie}` },
    });

  describe('with the browser client on', () => {
    beforeEach(() => boot());

    it('start → IdP → browser callback sets a browser session cookie and lands on /', async () => {
      const alice = await signedInUser(h, { email: 'alice@example.com' });
      const events = recordingAudit(h.hooks);
      idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true });
      const { res, authorizationUrl, flowCookie } = await start();
      const auth = new URL(authorizationUrl);
      expect(auth.origin).toBe(idp.url);
      expect(auth.searchParams.get('redirect_uri')).toBe('https://wirebench.test/api/v1/auth/oidc/browser-callback');
      expect(auth.searchParams.get('code_challenge_method')).toBe('S256');
      expect(auth.searchParams.get('code_challenge')).toBeTruthy();
      const state = auth.searchParams.get('state')!;
      expect(flowCookie).toBe(state);
      const flowLine = setCookies(res).find((l) => l.startsWith(`${FLOW_COOKIE}=`))!;
      expect(flowLine).toContain('HttpOnly');
      expect(flowLine).toContain('Secure');
      expect(flowLine).toContain('Path=/');
      expect(flowLine).toContain('Max-Age=600');
      // Only a hash of the state is stored.
      const rows = await h.db.query<{ state_hash: string; provider: string; nonce: string; code_verifier: string }>(
        'select * from browser_flows',
      );
      expect(rows.rows).toHaveLength(1);
      expect(rows.rows[0]).toMatchObject({ provider: 'oidc', state_hash: hashSecret(state), redirect_to: '/' });
      expect(JSON.stringify(rows.rows[0])).not.toContain(state);

      const back = await idp.authorize(authorizationUrl);
      const done = await callback(back, flowCookie);
      expect(done.statusCode, done.body).toBe(303);
      expect(done.headers['location']).toBe('/');
      const token = cookieValue(done, COOKIE)!;
      expect(token).toMatch(/^wbs_/);
      // The flow cookie is cleared.
      expect(setCookies(done).find((l) => l.startsWith(`${FLOW_COOKIE}=`))).toContain('Max-Age=0');
      const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `${COOKIE}=${token}` } });
      expect(me.statusCode).toBe(200);
      expect(me.json<{ user: { id: string } }>().user.id).toBe(alice.user.id);
      expect((await repo.tokensOfUser(h.db, alice.user.id)).map((t) => t.kind).sort()).toEqual(['browser', 'device']);
      expect(events.filter((e) => e.action === 'auth.signed_in').map((e) => e.details?.['method'])).toEqual(['oidc']);
      expect((await h.db.query('select 1 from browser_flows')).rowCount).toBe(0);
    });

    it('lands on a same-origin redirect_to and on / for a foreign one', async () => {
      await signedInUser(h, { email: 'alice@example.com' });
      let n = 0;
      // A fresh address each time, so the loop stays under the per-address limits on start and callback.
      const through = async (redirectTo: string) => {
        const address = `10.1.0.${(n += 1)}`;
        const { authorizationUrl, flowCookie } = await start(`?redirect_to=${encodeURIComponent(redirectTo)}`, address);
        // The start's single application is enough: the stored target is already safe.
        const stored = await h.db.query<{ redirect_to: string }>('select redirect_to from browser_flows');
        const done = await callback(await idp.authorize(authorizationUrl), flowCookie, address);
        expect(done.statusCode, done.body).toBe(303);
        return { stored: stored.rows[0]!.redirect_to, location: done.headers['location'] };
      };
      expect(await through('/w/1?tab=a')).toEqual({ stored: '/w/1?tab=a', location: '/w/1?tab=a' });
      for (const evil of EVIL_REDIRECTS) expect(await through(evil)).toEqual({ stored: '/', location: '/' });
    });

    it('refuses an ID token signed for another nonce', async () => {
      await signedInUser(h, { email: 'alice@example.com' });
      const { authorizationUrl, flowCookie } = await start();
      idp.nextNonce('a-nonce-this-flow-never-sent');
      const res = await callback(await idp.authorize(authorizationUrl), flowCookie);
      expect(res.statusCode).toBe(502);
      expect(cookieValue(res, COOKIE)).toBeUndefined();
    });

    it('still completes for a browser that already holds a session', async () => {
      const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
      const { authorizationUrl, flowCookie } = await start();
      const back = await idp.authorize(authorizationUrl);
      const done = await h.app.inject({
        method: 'GET',
        url: `${back.pathname}${back.search}`,
        headers: { cookie: `${COOKIE}=${alice.token}; ${FLOW_COOKIE}=${flowCookie}`, origin: 'https://idp.test' },
      });
      expect(done.statusCode, done.body).toBe(303);
      expect(cookieValue(done, COOKIE)).toMatch(/^wbs_/);
      // The session the cookie held ends, so no token outlives the cookie that carried it.
      const tokens = await repo.tokensOfUser(h.db, alice.user.id);
      expect(tokens.map((t) => t.id)).not.toContain(alice.tokenId);
    });

    it('refuses a replayed callback', async () => {
      await signedInUser(h, { email: 'alice@example.com' });
      const { authorizationUrl, flowCookie } = await start();
      const back = await idp.authorize(authorizationUrl);
      expect((await callback(back, flowCookie)).statusCode).toBe(303);
      const again = await callback(back, flowCookie);
      expect(again.statusCode).toBe(400);
      expect(again.headers['content-type']).toMatch(/^text\/html/);
      expect(cookieValue(again, COOKIE)).toBeUndefined();
      expect(idp.tokenRequests).toBe(1);
    });

    it('refuses an expired flow and deletes it', async () => {
      await signedInUser(h, { email: 'alice@example.com' });
      const { authorizationUrl, flowCookie } = await start();
      const back = await idp.authorize(authorizationUrl);
      h.clock.advance(10 * 60 * 1000 + 1);
      const res = await callback(back, flowCookie);
      expect(res.statusCode).toBe(400);
      expect(res.body).toContain('expired');
      // The re-rendered page carries the form, so it keeps the policy that lets its POST name its Origin.
      expect(res.headers['referrer-policy']).toBe('same-origin');
      expect(cookieValue(res, COOKIE)).toBeUndefined();
      expect(idp.tokenRequests).toBe(0);
      expect((await h.db.query('select 1 from browser_flows')).rowCount).toBe(0);
    });

    it('refuses a callback whose browser did not start the flow (login CSRF)', async () => {
      await signedInUser(h, { email: 'alice@example.com' });
      const { authorizationUrl } = await start();
      const back = await idp.authorize(authorizationUrl);
      for (const cookie of [undefined, 'someone-elses-state']) {
        const res = await callback(back, cookie);
        expect(res.statusCode).toBe(400);
        expect(cookieValue(res, COOKIE)).toBeUndefined();
        // A mismatch leaves this browser's own flow cookie alone.
        expect(setCookies(res).some((l) => l.startsWith(`${FLOW_COOKIE}=`))).toBe(false);
      }
      expect(idp.tokenRequests).toBe(0);
    });

    it('a cross-site callback with another state does not end the flow in progress', async () => {
      await signedInUser(h, { email: 'alice@example.com' });
      const { authorizationUrl, flowCookie } = await start();
      const back = await idp.authorize(authorizationUrl);
      const forged = new URL(back.href);
      forged.searchParams.set('state', 'attacker-state');
      expect((await callback(forged, flowCookie)).statusCode).toBe(400);
      expect((await callback(back, flowCookie)).statusCode).toBe(303);
    });

    it('rate-limits starts per address', async () => {
      for (let i = 0; i < 10; i += 1)
        expect(
          (await h.app.inject({ method: 'GET', url: '/sign-in/oidc', remoteAddress: '10.9.9.9' })).statusCode,
        ).toBe(302);
      expect((await h.app.inject({ method: 'GET', url: '/sign-in/oidc', remoteAddress: '10.9.9.9' })).statusCode).toBe(
        429,
      );
    });

    it('refuses an uninvited person with the page, records the failure and sets no session', async () => {
      const events = recordingAudit(h.hooks);
      idp.nextUser({ sub: 'sub-eve', email: 'eve@example.com', email_verified: true });
      const { authorizationUrl, flowCookie } = await start();
      const res = await callback(await idp.authorize(authorizationUrl), flowCookie);
      expect(res.statusCode).toBe(403);
      expect(res.body).toContain('Ask a server admin to invite you');
      expect(cookieValue(res, COOKIE)).toBeUndefined();
      expect(events.filter((e) => e.action === 'auth.sign_in_failed').map((e) => e.details)).toMatchObject([
        { method: 'oidc', reason: 'identity-not-invited' },
      ]);
    });

    it('leaves the desktop flow on its own redirect URI', async () => {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/oidc/start',
        payload: { device: { name: 'Mac' }, codeChallenge: 'c'.repeat(43), loopbackPort: 49152 },
      });
      expect(res.statusCode).toBe(201);
      const url = new URL(res.json<{ authorizationUrl: string }>().authorizationUrl);
      expect(url.searchParams.get('redirect_uri')).toBe('https://wirebench.test/api/v1/auth/oidc/callback');
    });
  });

  it('serves neither the start nor the callback with the browser client off', async () => {
    await boot(false);
    expect((await h.app.inject({ method: 'GET', url: '/sign-in/oidc' })).statusCode).toBe(404);
    expect(
      (await h.app.inject({ method: 'GET', url: '/api/v1/auth/oidc/browser-callback?state=x&code=y' })).statusCode,
    ).toBe(404);
  });
});
