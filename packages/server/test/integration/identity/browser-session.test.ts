import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ServerModule, SessionEnded } from '../../../src/context.js';
import type { IdentityEnv } from '../../../src/identity/env.js';
import { identitySettings } from '../../../src/identity/env.js';
import { requireUser } from '../../../src/identity/guard.js';
import * as repo from '../../../src/identity/repo.js';
import { sweepExpired } from '../../../src/identity/sessions.js';
import { mintToken, newId } from '../../../src/identity/tokens.js';
import { loadConfig } from '../../../src/config.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const DAY = 24 * 60 * 60 * 1000;
const PUBLIC_URL = 'https://wirebench.test';
const COOKIE = '__Host-wb_session';
const BROWSER_ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};

/** Routes registered after identity that only read `request.caller`, as other modules do. */
const probeModule: ServerModule = {
  name: 'teams-access',
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
  register: async (app) => {
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.post('/probe/write', { preHandler: requireUser }, async (request) => ({ via: request.caller?.via }));
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/probe/open', async (request) => ({ signedIn: request.caller !== undefined }));
  },
};

const withCookie = (token: string) => ({ cookie: `theme=dark; ${COOKIE}=${token}` });

describeDb('cookie sessions on the identity guard (hosted spec §17.2)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness({ env: BROWSER_ENV, modules: [probeModule] });
  });
  afterEach(() => h.close());

  it('lets a cookie holding a browser token reach GET /me', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: withCookie(alice.token) });
    expect(res.statusCode).toBe(200);
    expect(res.json<{ user: { email: string } }>().user.email).toBe('alice@example.com');
  });

  it('refuses a cookie POST without Origin or with a foreign one, and takes the public URL', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
    const post = (origin?: string) =>
      h.app.inject({
        method: 'POST',
        url: '/api/v1/probe/write',
        headers: { ...withCookie(alice.token), ...(origin !== undefined ? { origin } : {}) },
      });
    for (const origin of [undefined, 'https://evil.test', 'https://wirebench.test.evil.test', 'null']) {
      const res = await post(origin);
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('identity-origin-refused');
    }
    const ok = await post(PUBLIC_URL);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({ via: 'cookie' });
  });

  it('leaves a bearer POST without Origin alone, and prefers Authorization over the cookie', async () => {
    const desktop = await signedInUser(h, { email: 'desk@example.com' });
    const browser = await signedInUser(h, { email: 'web@example.com', kind: 'browser' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/probe/write',
      headers: { authorization: desktop.headers.authorization, ...withCookie(browser.token) },
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ via: 'bearer' });
  });

  it('answers 401 for an expired, a revoked, or a desktop token in the cookie', async () => {
    const idle = await signedInUser(h, { email: 'idle@example.com', kind: 'browser' });
    const revoked = await signedInUser(h, { email: 'revoked@example.com', kind: 'browser' });
    const desktop = await signedInUser(h, { email: 'desk@example.com' });
    await repo.revokeToken(h.db, revoked.tokenId, h.clock.now);
    const me = (token: string) => h.app.inject({ method: 'GET', url: '/api/v1/me', headers: withCookie(token) });
    expect((await me(revoked.token)).statusCode).toBe(401);
    expect((await me(desktop.token)).statusCode).toBe(401);
    h.clock.advance(31 * DAY);
    const res = await me(idle.token);
    expect(res.statusCode).toBe(401);
    expect(res.json<{ code: string }>().code).toBe('identity-unauthenticated');
  });

  it('treats a stale cookie as signed out, so a route without requireUser still answers', async () => {
    const res = await h.app.inject({
      method: 'GET',
      url: '/api/v1/probe/open',
      headers: withCookie(mintToken().token),
    });
    expect(res.statusCode).toBe(200);
    expect(res.json()).toEqual({ signedIn: false });
  });

  it('signs a cookie caller out: revokes the row, clears the cookie, announces sessionEnded', async () => {
    const ended: SessionEnded[] = [];
    h.hooks.sessionEnded.push((event) => {
      ended.push(event);
    });
    const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
    const res = await h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/sign-out',
      headers: { ...withCookie(alice.token), origin: PUBLIC_URL },
    });
    expect(res.statusCode).toBe(204);
    expect([res.headers['set-cookie']].flat()).toEqual([
      `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
    ]);
    expect(await repo.tokensOfUser(h.db, alice.user.id)).toHaveLength(0);
    expect(ended).toEqual([{ tokenId: alice.tokenId }]);
    const after = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: withCookie(alice.token) });
    expect(after.statusCode).toBe(401);
  });

  it('still clears a stale cookie on sign-out, answering 401', async () => {
    const revoked = await signedInUser(h, { email: 'revoked@example.com', kind: 'browser' });
    await repo.revokeToken(h.db, revoked.tokenId, h.clock.now);
    for (const token of [revoked.token, mintToken().token]) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/sign-out',
        headers: { ...withCookie(token), origin: PUBLIC_URL },
      });
      expect(res.statusCode).toBe(401);
      expect(res.json<{ code: string }>().code).toBe('identity-unauthenticated');
      expect([res.headers['set-cookie']].flat()).toEqual([
        `${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure; SameSite=Lax`,
      ]);
    }
    // No cookie at all: nothing to clear.
    const bare = await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out' });
    expect(bare.statusCode).toBe(401);
    expect(bare.headers['set-cookie']).toBeUndefined();
  });

  it('signs a bearer caller out without touching cookies', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const res = await h.app.inject({ method: 'POST', url: '/api/v1/auth/sign-out', headers: alice.headers });
    expect(res.statusCode).toBe(204);
    expect(res.headers['set-cookie']).toBeUndefined();
  });

  it('records the token kind, and the daily sweep deletes expired browser flows', async () => {
    const web = await signedInUser(h, { email: 'web@example.com', kind: 'browser' });
    expect((await repo.tokensOfUser(h.db, web.user.id))[0]!.kind).toBe('browser');
    const desk = await signedInUser(h, { email: 'desk@example.com' });
    expect((await repo.tokensOfUser(h.db, desk.user.id))[0]!.kind).toBe('device');

    const flow = (id: string, expiresAt: Date) =>
      h.db.query(
        `insert into browser_flows (id, provider, state_hash, redirect_to, expires_at) values ($1, 'oidc', $2, '/', $3)`,
        [id, newId(), expiresAt],
      );
    await flow('old', new Date(h.clock.now.getTime() - 1000));
    await flow('live', new Date(h.clock.now.getTime() + 600_000));
    const settings = identitySettings(
      loadConfig(
        {
          WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
          WIREBENCH_SERVER_PUBLIC_URL: PUBLIC_URL,
          WIREBENCH_SERVER_DATA_DIR: process.cwd(),
        },
        '0.0.0-test',
      ),
    );
    await sweepExpired({ ctx: { db: h.db }, settings, now: () => h.clock.now } as unknown as IdentityEnv);
    const left = (await h.db.query('select id from browser_flows order by id')).rows.map((row) => row.id as string);
    expect(left).toEqual(['live']);
  });
});

describeDb('cookie sessions with the browser client off', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  it('ignores the cookie entirely', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
    const res = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: withCookie(alice.token) });
    expect(res.statusCode).toBe(401);
  });
});
