/**
 * The browser tab served at the root (hosted edition spec §17.2, §17.6): `/` and the renderer's other page
 * paths behind the browser session, the build's assets without one, traversal refused, the root
 * `POST /sign-out`, and nothing of it while the browser client is off. The build is a fixture
 * (`helpers/browser-build.ts`), so no Vite build is needed.
 */
import { connect } from 'node:net';
import { afterEach, beforeEach, expect, it } from 'vitest';
import type { SessionEnded } from '../../../src/context.js';
import { BROWSER_CONTENT_SECURITY_POLICY } from '../../../src/host/browser-client.js';
import { hostModule } from '../../../src/host/module.js';
import { sessionCookieName } from '../../../src/identity/cookies.js';
import * as repo from '../../../src/identity/repo.js';
import { hashToken } from '../../../src/identity/tokens.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { describeDb } from '../../helpers/database.js';
import { browserUser, hostHarness, openHost, PUBLIC_URL, type HostHarness } from '../../helpers/host.js';
import { identityHarness, signedInUser } from '../../helpers/identity.js';

const COOKIE = sessionCookieName(PUBLIC_URL);
const IMMUTABLE = 'public, max-age=31536000, immutable';
const DAY = 24 * 60 * 60 * 1000;

const cookie = (token: string) => ({ cookie: `theme=dark; ${COOKIE}=${token}` });

/** One request over a bare socket, its path sent exactly as given: `fetch` and `inject` would normalise it. */
async function rawGet(
  port: number,
  path: string,
  headers: Record<string, string> = {},
): Promise<{ status: number; text: string }> {
  const socket = connect(port, '127.0.0.1');
  const lines = [`GET ${path} HTTP/1.1`, `Host: 127.0.0.1:${port}`, 'Connection: close'];
  for (const [name, value] of Object.entries(headers)) lines.push(`${name}: ${value}`);
  socket.write(`${lines.join('\r\n')}\r\n\r\n`);
  const chunks: Buffer[] = [];
  socket.on('data', (chunk: Buffer) => chunks.push(chunk));
  await new Promise<void>((resolve, reject) => {
    socket.once('close', () => resolve());
    socket.once('error', reject);
  });
  const text = Buffer.concat(chunks).toString('utf8');
  return { status: Number(/^HTTP\/1\.1 (\d{3})/.exec(text)?.[1]), text };
}

describeDb('the browser tab at the root (hosted spec §17.2, §17.6)', () => {
  let h: HostHarness;
  beforeEach(async () => {
    h = await hostHarness();
  });
  afterEach(() => h.close());

  it('sends a browser without a session to /sign-in, carrying the path it asked for', async () => {
    const res = await h.app.inject({ method: 'GET', url: '/' });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/sign-in?redirect_to=/');
    expect(res.headers['cache-control']).toBe('no-store');
    expect(res.headers['content-security-policy']).toBeUndefined();

    const deep = await h.app.inject({ method: 'GET', url: '/workspaces/x' });
    expect(deep.statusCode).toBe(303);
    expect(deep.headers.location).toBe('/sign-in?redirect_to=/workspaces/x');

    const query = await h.app.inject({ method: 'GET', url: '/workspaces/x?tab=send&a=1' });
    const location = new URL(String(query.headers.location), PUBLIC_URL);
    expect(location.pathname).toBe('/sign-in');
    expect(location.searchParams.get('redirect_to')).toBe('/workspaces/x?tab=send&a=1');
  });

  it('serves index.html to a browser session with the §17.6 policy as a header, never cached', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    for (const url of ['/', '/workspaces/x', '/workspaces/x/']) {
      const res = await h.app.inject({ method: 'GET', url, headers: cookie(alice.token) });
      expect(res.statusCode, url).toBe(200);
      expect(res.body).toBe(h.browserBuild.page);
      expect(res.headers['content-type']).toBe('text/html; charset=utf-8');
      expect(res.headers['content-security-policy']).toBe(
        "default-src 'self'; style-src 'self' 'unsafe-inline'; img-src 'self' data:; connect-src 'self'; frame-ancestors 'none'",
      );
      expect(res.headers['cache-control']).toBe('no-store');
      expect(res.headers['x-content-type-options']).toBe('nosniff');
      expect(res.headers['referrer-policy']).toBe('same-origin');
    }
    expect(BROWSER_CONTENT_SECURITY_POLICY).toContain("frame-ancestors 'none'");
  });

  it('takes only a live browser session: a desktop token, a revoked or expired one and a disabled user redirect', async () => {
    const desktop = await signedInUser(h, { email: 'desk@example.com' });
    const revoked = await browserUser(h, 'revoked@example.com');
    await repo.revokeToken(h.db, revoked.tokenId, h.clock.now);
    const disabled = await signedInUser(h, { email: 'off@example.com', kind: 'browser', disabled: true });
    for (const token of [desktop.token, revoked.token, disabled.token, 'not-a-token']) {
      const res = await h.app.inject({ method: 'GET', url: '/', headers: cookie(token) });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/sign-in?redirect_to=/');
    }
    const later = await browserUser(h, 'later@example.com');
    h.clock.advance(400 * DAY);
    const expired = await h.app.inject({ method: 'GET', url: '/', headers: cookie(later.token) });
    expect(expired.statusCode).toBe(303);
  });

  it('serves a hashed asset without a session as immutable, and an unhashed one as no-cache', async () => {
    const res = await h.app.inject({ method: 'GET', url: h.browserBuild.hashedAsset });
    expect(res.statusCode).toBe(200);
    expect(res.body).toBe(h.browserBuild.hashedBody);
    expect(res.headers['content-type']).toMatch(/^(text|application)\/javascript/);
    expect(res.headers['cache-control']).toBe(IMMUTABLE);
    expect(res.headers['x-content-type-options']).toBe('nosniff');
    expect(res.headers['referrer-policy']).toBe('same-origin');

    const head = await h.app.inject({ method: 'HEAD', url: h.browserBuild.hashedAsset });
    expect(head.statusCode).toBe(200);

    const plain = await h.app.inject({ method: 'GET', url: h.browserBuild.plainAsset });
    expect(plain.statusCode).toBe(200);
    expect(plain.headers['cache-control']).toBe('no-cache');
  });

  it('answers 404 for a missing asset, a dotfile and an unknown API path, never the page', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const urls = [
      '/assets/missing-AAAAAAAA.js',
      '/assets/.secret',
      '/assets/',
      '/assets',
      '/%61ssets/x',
      '/api/v1/nothing-here',
      '/api',
      '/api/',
      '/%61pi/v1/nothing-here',
      '/%61%70%69',
    ];
    for (const url of urls) {
      for (const headers of [{}, cookie(alice.token)]) {
        const res = await h.app.inject({ method: 'GET', url, headers });
        expect(res.statusCode, url).toBe(404);
        expect(res.body).not.toContain('a dotfile');
        expect(res.body).not.toContain('<div id="root">');
      }
    }
  });

  it('answers 404 for every traversal spelling, with or without a session', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    const paths = [
      '/../package.json',
      '/assets/../../package.json',
      '/assets/../index.html',
      '/%2e%2e/package.json',
      '/%2E%2E/%2e%2e/package.json',
      '/assets/%2e%2e/%2e%2e/package.json',
      '/..%2fpackage.json',
      '/assets/..%2f..%2fpackage.json',
      '/assets%2f..%2fpackage.json',
      '/assets/..%5c..%5cpackage.json',
      '/./workspaces',
      '//etc/passwd',
      '/a/%00/b',
    ];
    for (const path of paths) {
      for (const headers of [{}, cookie(alice.token)]) {
        const res = await rawGet(h.port, path, headers);
        expect(res.status, path).toBe(404);
        expect(res.text).not.toContain('"@wirebench/server"');
        expect(res.text).not.toContain('<div id="root">');
      }
    }
    // A malformed escape is the router's own 400, before any route.
    expect((await rawGet(h.port, '/%zz', cookie(alice.token))).status).toBe(400);
  });

  it('POST /sign-out revokes the session, clears the cookie, closes its host socket 4401 and lands on /sign-in', async () => {
    const ended: SessionEnded[] = [];
    h.hooks.sessionEnded.push((event) => {
      ended.push(event);
    });
    const alice = await browserUser(h, 'alice@example.com');
    const client = await openHost(h, alice);
    await client.waitFor((frame) => frame.type === 'hello');
    const res = await h.app.inject({
      method: 'POST',
      url: '/sign-out',
      headers: { ...cookie(alice.token), origin: PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(res.statusCode).toBe(303);
    expect(res.headers.location).toBe('/sign-in');
    expect(String(res.headers['set-cookie'])).toMatch(new RegExp(`^${COOKIE}=; Max-Age=0; Path=/; HttpOnly; Secure`));
    expect(ended).toEqual([{ tokenId: alice.tokenId }]);
    expect((await repo.tokenByHash(h.db, hashToken(alice.token)))?.token.revokedAt).not.toBeNull();
    expect(await client.closed).toEqual({ code: 4401 });
    expect(h.audit.filter((event) => event.action === 'auth.signed_out')).toEqual([
      expect.objectContaining({
        actor: expect.objectContaining({ kind: 'user', userId: alice.user.id, tokenId: alice.tokenId }) as unknown,
        details: { tokenId: alice.tokenId },
      }),
    ]);
    const after = await h.app.inject({ method: 'GET', url: '/', headers: cookie(alice.token) });
    expect(after.statusCode).toBe(303);
  });

  it('POST /sign-out with a stale or missing cookie still clears it and redirects', async () => {
    const stale = await browserUser(h, 'stale@example.com');
    await repo.revokeToken(h.db, stale.tokenId, h.clock.now);
    for (const headers of [cookie(stale.token), {}]) {
      const res = await h.app.inject({ method: 'POST', url: '/sign-out', headers: { ...headers, origin: PUBLIC_URL } });
      expect(res.statusCode).toBe(303);
      expect(res.headers.location).toBe('/sign-in');
      expect(String(res.headers['set-cookie'])).toContain(`${COOKIE}=; Max-Age=0`);
    }
    expect(h.audit.filter((event) => event.action === 'auth.signed_out')).toEqual([]);
  });

  it('POST /sign-out refuses another Origin, or none, and leaves the session alone', async () => {
    const alice = await browserUser(h, 'alice@example.com');
    for (const origin of [undefined, 'https://evil.test', 'null']) {
      const res = await h.app.inject({
        method: 'POST',
        url: '/sign-out',
        headers: { ...cookie(alice.token), ...(origin !== undefined ? { origin } : {}) },
      });
      expect(res.statusCode).toBe(403);
      expect(res.json<{ code: string }>().code).toBe('identity-origin-refused');
      expect(res.headers['set-cookie']).toBeUndefined();
    }
    expect((await repo.tokenByHash(h.db, hashToken(alice.token)))?.token.revokedAt).toBeNull();
  });
});

describeDb('the browser tab while it cannot be served', () => {
  it('is 404 at /, /sign-out and the assets with the browser client off', async () => {
    const h = await identityHarness({ modules: [hostModule()] });
    try {
      const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
      for (const url of ['/', '/workspaces/x', '/assets/index-Ab3_9-xZ.js']) {
        const res = await h.app.inject({ method: 'GET', url, headers: cookie(alice.token) });
        expect(res.statusCode, url).toBe(404);
      }
      const signOut = await h.app.inject({ method: 'POST', url: '/sign-out', headers: { origin: PUBLIC_URL } });
      expect(signOut.statusCode).toBe(404);
    } finally {
      await h.close();
    }
  });

  it('refuses to start with the browser client on and no build', async () => {
    const empty = await mkTempDir('wbs-no-browser-');
    try {
      await expect(hostHarness({ browserRoot: empty })).rejects.toThrow(/The browser client is not built/);
    } finally {
      await removeTempDir(empty);
    }
  });
});
