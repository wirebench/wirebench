/**
 * Switch accounts on the server (switch accounts spec §5, §8, §10; plan Task 3): one browser holds several sessions,
 * the active one in `__Host-wb_session` and up to four more in `__Host-wb_accounts`. Adding an account keeps the
 * session the browser holds; switching swaps two; signing out promotes the next; `?all=1` ends them all; and
 * `GET /me/accounts` lists the remembered people, dropping dead sessions.
 */
import { afterEach, describe, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { local, type SessionEnded } from '../../../src/context.js';
import { recordingAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { identityHarness, signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';

const PUBLIC_URL = 'https://wirebench.test';
const SESSION = '__Host-wb_session';
const ACCOUNTS = '__Host-wb_accounts';
const FLOW_COOKIE = '__Host-wb_flow';
const DAY = 86_400_000;
const MAX_AGE = 180 * 24 * 60 * 60;
const PASSWORD = 'correct horse battery';
const BROWSER_ENV = { WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64') };
const FULL_MESSAGE = 'This browser already holds five accounts. Sign one out first.';

type Injected = Awaited<ReturnType<IdentityHarness['app']['inject']>>;
const setCookies = (res: Injected): string[] => {
  const header = res.headers['set-cookie'];
  return header === undefined ? [] : Array.isArray(header) ? header : [String(header)];
};
const lineOf = (res: Injected, name: string): string | undefined =>
  setCookies(res).find((line) => line.startsWith(`${name}=`));
const valueOf = (res: Injected, name: string): string | undefined =>
  lineOf(res, name)
    ?.slice(name.length + 1)
    .split(';')[0];
const cookies = (active?: SignedInUser | string, remembered: readonly (SignedInUser | string)[] = []): string => {
  const token = (one: SignedInUser | string) => (typeof one === 'string' ? one : one.token);
  return [
    ...(active === undefined ? [] : [`${SESSION}=${token(active)}`]),
    ...(remembered.length === 0 ? [] : [`${ACCOUNTS}=${remembered.map(token).join(' ')}`]),
  ].join('; ');
};

describeDb('switch accounts in the browser (switch accounts spec §5)', () => {
  let h: IdentityHarness;
  let idp: FakeOidcIssuer | undefined;
  afterEach(async () => {
    await h.close();
    await idp?.close();
    idp = undefined;
  });

  const boot = async () => {
    h = await identityHarness({ env: BROWSER_ENV });
  };
  const browserUser = (email: string, password?: string) =>
    signedInUser(h, { email, kind: 'browser', ...(password === undefined ? {} : { password }) });
  const post = (url: string, cookie: string, fields: Record<string, string> = {}, origin: string | null = PUBLIC_URL) =>
    h.app.inject({
      method: 'POST',
      url,
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        ...(cookie === '' ? {} : { cookie }),
        ...(origin === null ? {} : { origin }),
      },
      payload: new URLSearchParams(fields).toString(),
    });
  const me = async (token: string) => {
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `${SESSION}=${token}` } });
    return res.statusCode === 200 ? res.json<{ user: { id: string } }>().user.id : res.statusCode;
  };
  const live = async (user: SignedInUser) =>
    (await repo.tokensOfUser(h.tdb, user.user.id)).some((token) => token.id === user.tokenId);

  describe('the Add an account page', () => {
    it('says so, keeps add=1 on every method, and offers Cancel back to redirect_to', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const res = await h.app.inject({
        method: 'GET',
        url: '/sign-in?add=1&redirect_to=%2Fw%2F1%3Fa%3D%22',
        headers: { cookie: cookies(alice) },
      });
      expect(res.statusCode).toBe(200);
      expect(res.body).toContain('<h1>Add an account</h1>');
      expect(res.body).toContain('<input type="hidden" name="add" value="1">');
      expect(res.body).toContain('name="redirect_to" value="/w/1?a=%22"');
      expect(res.body).toContain('<a class="method" href="/w/1?a=%22">Cancel</a>');
      expect(res.body).not.toContain(alice.token);
      expect(res.body).not.toContain('<script');
    });

    it('is the plain page without a live session to keep, and for a foreign redirect_to cancels to /', async () => {
      await boot();
      const plain = await h.app.inject({ method: 'GET', url: '/sign-in?add=1' });
      expect(plain.body).toContain('<h1>Sign in</h1>');
      expect(plain.body).not.toContain('name="add"');
      const alice = await browserUser('alice@example.com');
      const foreign = await h.app.inject({
        method: 'GET',
        url: '/sign-in?add=1&redirect_to=https%3A%2F%2Fevil.test%2F',
        headers: { cookie: cookies(alice) },
      });
      expect(foreign.body).not.toContain('evil.test');
      expect(foreign.body).toContain('href="/">Cancel</a>');
    });

    it('refuses at five accounts, before any form', async () => {
      await boot();
      const [active, ...remembered] = await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((name) => browserUser(`${name}@example.com`)),
      );
      const res = await h.app.inject({
        method: 'GET',
        url: '/sign-in?add=1',
        headers: { cookie: cookies(active, remembered) },
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain(FULL_MESSAGE);
      expect(res.body).toContain('Cancel</a>');
      expect(res.body).not.toContain('<form');
    });
  });

  describe('adding an account with the password form', () => {
    it('keeps the old session: it moves into wb_accounts and the new one becomes active', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const carol = await browserUser('carol@example.com');
      const bob = await signedInUser(h, { email: 'bob@example.com', password: PASSWORD });
      const events = recordingAudit(h.hooks);
      const res = await post('/sign-in/local', cookies(alice, [carol]), {
        identifier: 'bob@example.com',
        password: PASSWORD,
        add: '1',
        redirect_to: '/w/1',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers['location']).toBe('/w/1');
      const token = valueOf(res, SESSION)!;
      expect(await me(token)).toBe(bob.user.id);
      // Most recent first: the one just active, then the others.
      expect(valueOf(res, ACCOUNTS)).toBe(`${alice.token} ${carol.token}`);
      const line = lineOf(res, ACCOUNTS)!;
      expect(line).toContain(`Max-Age=${MAX_AGE}`);
      expect(line).toContain('Path=/; HttpOnly; Secure; SameSite=Lax');
      expect(await live(alice)).toBe(true);
      expect(await me(alice.token)).toBe(alice.user.id);
      expect(events.map((event) => event.action)).toEqual(['auth.signed_in']);
    });

    it('replaces the entry of a person already remembered, ending that session', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com', PASSWORD);
      const res = await post('/sign-in/local', cookies(alice, [bob]), {
        identifier: 'bob@example.com',
        password: PASSWORD,
        add: '1',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(await me(valueOf(res, SESSION)!)).toBe(bob.user.id);
      expect(valueOf(res, ACCOUNTS)).toBe(alice.token);
      expect(await live(bob)).toBe(false);
    });

    it('signing in again as the active person replaces the active session and remembers nothing new', async () => {
      await boot();
      const alice = await browserUser('alice@example.com', PASSWORD);
      const res = await post('/sign-in/local', cookies(alice), {
        identifier: 'alice@example.com',
        password: PASSWORD,
        add: '1',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(await me(valueOf(res, SESSION)!)).toBe(alice.user.id);
      expect(lineOf(res, ACCOUNTS)).toBeUndefined();
      expect(await live(alice)).toBe(false);
    });

    it('refuses a sixth account without signing anyone in or out', async () => {
      await boot();
      const [active, ...remembered] = await Promise.all(
        ['a', 'b', 'c', 'd', 'e'].map((name) => browserUser(`${name}@example.com`)),
      );
      const frank = await signedInUser(h, { email: 'frank@example.com', password: PASSWORD });
      const res = await post('/sign-in/local', cookies(active, remembered), {
        identifier: 'frank@example.com',
        password: PASSWORD,
        add: '1',
      });
      expect(res.statusCode).toBe(409);
      expect(res.body).toContain(FULL_MESSAGE);
      expect(setCookies(res)).toEqual([]);
      expect(await repo.tokensOfUser(h.tdb, frank.user.id)).toHaveLength(1);
      expect(await live(active!)).toBe(true);
    });

    it('a refused password keeps the add mode on the page it answers', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      await signedInUser(h, { email: 'bob@example.com', password: PASSWORD });
      const res = await post('/sign-in/local', cookies(alice), {
        identifier: 'bob@example.com',
        password: 'wrong one!',
        add: '1',
      });
      expect(res.statusCode).toBe(401);
      expect(res.body).toContain('<h1>Add an account</h1>');
      expect(res.body).toContain('name="add" value="1"');
    });

    it('without add mode still ends the session the browser held, and keeps the remembered ones', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const carol = await browserUser('carol@example.com');
      await signedInUser(h, { email: 'bob@example.com', password: PASSWORD });
      const res = await post('/sign-in/local', cookies(alice, [carol]), {
        identifier: 'bob@example.com',
        password: PASSWORD,
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(await live(alice)).toBe(false);
      expect(valueOf(res, ACCOUNTS)).toBe(carol.token);
    });
  });

  describe('adding an account through OIDC', () => {
    it('carries add mode on the flow cookie through the round trip and keeps the old session', async () => {
      idp = await startFakeOidcIssuer();
      h = await identityHarness({
        env: {
          WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
          WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
          WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
          WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
          ...BROWSER_ENV,
        },
      });
      const alice = await browserUser('alice@example.com');
      const bob = await signedInUser(h, { email: 'bob@example.com' });
      const page = await h.app.inject({
        method: 'GET',
        url: '/sign-in?add=1&redirect_to=%2Fw',
        headers: { cookie: cookies(alice) },
      });
      expect(page.body).toContain('href="/sign-in/oidc?add=1&amp;redirect_to=%2Fw"');
      idp.nextUser({ sub: 'sub-bob', email: 'bob@example.com', email_verified: true });
      const start = await h.app.inject({
        method: 'GET',
        url: '/sign-in/oidc?add=1&redirect_to=%2Fw',
        remoteAddress: '127.0.0.1',
      });
      expect(start.statusCode, start.body).toBe(302);
      const state = new URL(String(start.headers['location'])).searchParams.get('state')!;
      const flow = valueOf(start, FLOW_COOKIE)!;
      expect(flow).toBe(`${state}.add`);
      const back = await idp.authorize(String(start.headers['location']));
      const done = await h.app.inject({
        method: 'GET',
        url: `${back.pathname}${back.search}`,
        remoteAddress: '127.0.0.1',
        headers: { cookie: `${cookies(alice)}; ${FLOW_COOKIE}=${flow}` },
      });
      expect(done.statusCode, done.body).toBe(303);
      expect(done.headers['location']).toBe('/w');
      expect(await me(valueOf(done, SESSION)!)).toBe(bob.user.id);
      expect(valueOf(done, ACCOUNTS)).toBe(alice.token);
      expect(await live(alice)).toBe(true);
    });
  });

  describe('POST /sign-in/switch', () => {
    it('swaps the active session with the chosen one and records user.session_switched', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      const carol = await browserUser('carol@example.com');
      h.clock.advance(10 * DAY);
      const events = recordingAudit(h.hooks);
      const res = await post('/sign-in/switch', cookies(alice, [carol, bob]), {
        user: bob.user.id,
        redirect_to: '/w/2',
      });
      expect(res.statusCode, res.body).toBe(303);
      expect(res.headers['location']).toBe('/w/2');
      expect(valueOf(res, SESSION)).toBe(bob.token);
      // The session cookie lives as long as that token has left.
      expect(lineOf(res, SESSION)).toContain(`Max-Age=${MAX_AGE - 10 * 86_400}`);
      expect(valueOf(res, ACCOUNTS)).toBe(`${alice.token} ${carol.token}`);
      expect(events).toEqual([
        expect.objectContaining({
          action: 'user.session_switched',
          actor: { kind: 'user', userId: alice.user.id, email: alice.user.email, tokenId: alice.tokenId },
          target: { kind: 'user', id: bob.user.id },
          details: { from: alice.user.id },
        }),
      ]);
      expect(await live(alice)).toBe(true);
    });

    it('lands on / for a foreign redirect_to', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      const res = await post('/sign-in/switch', cookies(alice, [bob]), {
        user: bob.user.id,
        redirect_to: '//evil.test/',
      });
      expect(res.headers['location']).toBe('/');
    });

    it('refuses a user the browser holds no session for, switching nothing', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      const stranger = await browserUser('stranger@example.com');
      const res = await post('/sign-in/switch', cookies(alice, [bob]), { user: stranger.user.id, redirect_to: '/w' });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/sign-in?add=1&redirect_to=%2Fw');
      expect(setCookies(res)).toEqual([]);
    });

    it('drops a dead session (revoked, expired, disabled user, desktop token) and sends the tab to sign in', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const revoked = await browserUser('revoked@example.com');
      const disabled = await browserUser('disabled@example.com');
      const desktop = await signedInUser(h, { email: 'desk@example.com' });
      const bob = await browserUser('bob@example.com');
      await repo.revokeToken(h.tdb, revoked.tokenId, h.clock.now);
      await repo.setDisabled(h.tdb, disabled.user.id, h.clock.now);
      for (const dead of [revoked, disabled, desktop]) {
        const res = await post('/sign-in/switch', cookies(alice, [dead, bob]), { user: dead.user.id });
        expect(res.statusCode).toBe(303);
        expect(res.headers['location']).toBe('/sign-in?add=1');
        expect(valueOf(res, ACCOUNTS)).toBe(bob.token);
        expect(lineOf(res, SESSION)).toBeUndefined();
      }
      // Past its idle age, a session is dead too, and so is the active one: the tab signs in plainly.
      h.clock.advance(31 * DAY);
      const res = await post('/sign-in/switch', cookies(alice, [bob]), { user: bob.user.id });
      expect(res.headers['location']).toBe('/sign-in');
      expect(lineOf(res, ACCOUNTS)).toBe(`${ACCOUNTS}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`);
    });

    it('treats another tenant’s token as unknown', async () => {
      await boot();
      const second = await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: 'second', name: 'Second' });
      const alice = await browserUser('alice@example.com');
      const foreign = await signedInUser(h, {
        email: 'foreign@example.com',
        kind: 'browser',
        tdb: h.ctx.tenancy.db(second.scope),
      });
      const res = await post('/sign-in/switch', cookies(alice, [foreign]), { user: foreign.user.id });
      expect(res.headers['location']).toBe('/sign-in?add=1');
      expect(lineOf(res, SESSION)).toBeUndefined();
      expect(lineOf(res, ACCOUNTS)).toContain('Max-Age=0');
    });

    it('refuses a post from another origin or with none', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      for (const origin of [null, 'https://evil.test', 'null']) {
        const res = await post('/sign-in/switch', cookies(alice, [bob]), { user: bob.user.id }, origin);
        expect(res.statusCode).toBe(403);
        expect(res.json<{ code: string }>().code).toBe('identity-origin-refused');
        expect(setCookies(res)).toEqual([]);
      }
    });
  });

  describe('POST /sign-out', () => {
    it('ends the active session only and promotes the most recent remembered one', async () => {
      await boot();
      const ended: SessionEnded[] = [];
      h.hooks.sessionEnded.push(local((event) => void ended.push(event)));
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      const carol = await browserUser('carol@example.com');
      const res = await post('/sign-out', cookies(alice, [bob, carol]), { redirect_to: '/w/3' });
      expect(res.statusCode).toBe(303);
      expect(res.headers['location']).toBe('/w/3');
      expect(valueOf(res, SESSION)).toBe(bob.token);
      expect(valueOf(res, ACCOUNTS)).toBe(carol.token);
      expect(await live(alice)).toBe(false);
      expect(await live(bob)).toBe(true);
      expect(ended).toEqual([{ tenantId: h.tdb.scope.tenantId, tokenId: alice.tokenId }]);
    });

    it('clears both cookies and lands on /sign-in when no remembered session is live', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const revoked = await browserUser('revoked@example.com');
      await repo.revokeToken(h.tdb, revoked.tokenId, h.clock.now);
      const res = await post('/sign-out', cookies(alice, [revoked]));
      expect(res.headers['location']).toBe('/sign-in');
      expect(setCookies(res)).toEqual([
        `${SESSION}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
        `${ACCOUNTS}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      ]);
    });

    it('with ?all=1 ends every session the browser holds', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      const carol = await browserUser('carol@example.com');
      const events = recordingAudit(h.hooks);
      const res = await post('/sign-out?all=1', cookies(alice, [bob, carol]));
      expect(res.headers['location']).toBe('/sign-in');
      for (const user of [alice, bob, carol]) expect(await live(user)).toBe(false);
      expect(events.map((event) => [event.action, event.target.id])).toEqual([
        ['auth.signed_out', alice.user.id],
        ['auth.signed_out', bob.user.id],
        ['auth.signed_out', carol.user.id],
      ]);
      expect(lineOf(res, ACCOUNTS)).toContain('Max-Age=0');
      expect(lineOf(res, SESSION)).toContain('Max-Age=0');
    });

    it('refuses a post from another origin', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const res = await post('/sign-out?all=1', cookies(alice), {}, 'https://evil.test');
      expect(res.statusCode).toBe(403);
      expect(await live(alice)).toBe(true);
    });
  });

  describe('GET /api/v1/me/accounts', () => {
    it('lists the remembered people, never tokens, and drops dead sessions from the cookie', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const bob = await browserUser('bob@example.com');
      const revoked = await browserUser('revoked@example.com');
      await repo.revokeToken(h.tdb, revoked.tokenId, h.clock.now);
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/me/accounts',
        headers: { cookie: cookies(alice, [revoked, bob]) },
      });
      expect(res.statusCode, res.body).toBe(200);
      expect(res.json()).toEqual([
        { userId: bob.user.id, displayName: 'bob', email: 'bob@example.com', username: null, photo: null },
      ]);
      expect(res.body).not.toContain('wbs_');
      expect(valueOf(res, ACCOUNTS)).toBe(bob.token);
      // Nothing dead: the cookie is left alone.
      const again = await h.app.inject({
        method: 'GET',
        url: '/api/v1/me/accounts',
        headers: { cookie: cookies(alice, [bob]) },
      });
      expect(setCookies(again)).toEqual([]);
    });

    it('answers an empty list for a browser with no other account', async () => {
      await boot();
      const alice = await browserUser('alice@example.com');
      const res = await h.app.inject({
        method: 'GET',
        url: '/api/v1/me/accounts',
        headers: { cookie: cookies(alice) },
      });
      expect(res.json()).toEqual([]);
    });

    it('is for cookie callers only', async () => {
      await boot();
      const desktop = await signedInUser(h, { email: 'desk@example.com' });
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/me/accounts', headers: desktop.headers });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('identity-browser-only');
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/me/accounts' })).statusCode).toBe(401);
    });
  });
});
