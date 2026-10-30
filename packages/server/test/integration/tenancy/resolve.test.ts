/**
 * Tenant resolution and the tenant's URL (hosted edition spec §19.5; plan Task 6), as the app role. Self-hosted
 * mode never reads `Host`; hosted mode resolves `<slug>.<appDomain>` and answers anything else `404` with an
 * empty body. The cookie's name and `Secure`, the `Origin` checks and the URLs the server prints follow the
 * request's tenant.
 */
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import fastifyWebsocket from '@fastify/websocket';
import type { FastifyInstance } from 'fastify';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import type { ServerModule } from '../../../src/context.js';
import { requireUser } from '../../../src/identity/guard.js';
import type { OidcProvider } from '../../../src/identity/oidc.js';
import { mintSecret, newId, pkceChallenge } from '../../../src/identity/tokens.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import type { TenantResolver } from '../../../src/tenancy/resolve.js';
import { describeDb } from '../../helpers/database.js';
import { OIDC_ENV, identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const PUBLIC_URL = 'https://wirebench.test';
const APP_DOMAIN = 'example.test';
const BROWSER_ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: APP_DOMAIN });

/** An OIDC provider that would answer anything: hosted mode must not use it (spec §19.1). */
const provider: OidcProvider = {
  issuer: OIDC_ENV.WIREBENCH_SERVER_OIDC_ISSUER,
  authorizationUrl: () => `${OIDC_ENV.WIREBENCH_SERVER_OIDC_ISSUER}/authorize`,
  exchange: () => Promise.reject(new Error('hosted mode reached the provider')),
};
const VERIFIER = 'v'.repeat(43);

/** Every OIDC route, desktop and browser: the starts, the callbacks and the completion. */
const OIDC_ROUTES: readonly { readonly method: 'GET' | 'POST'; readonly url: string; readonly payload?: object }[] = [
  {
    method: 'POST',
    url: '/api/v1/auth/oidc/start',
    payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: 49152 },
  },
  { method: 'GET', url: '/api/v1/auth/oidc/callback?state=some-state&code=some-code' },
  { method: 'GET', url: '/api/v1/auth/oidc/browser-callback?state=some-state&code=some-code' },
  {
    method: 'POST',
    url: '/api/v1/auth/oidc/complete',
    payload: { flowId: newId(), grant: mintSecret().secret, codeVerifier: VERIFIER },
  },
  { method: 'GET', url: '/sign-in/oidc' },
];

/** The API scope the WebSocket plugin decorates with `injectWS`, per built server. */
const socketScopes = new WeakMap<FastifyInstance, FastifyInstance>();
let lastScope: FastifyInstance | undefined;

/** Echoes the request's tenant on the API, at the root (a public route) and over a WebSocket upgrade. */
const probeModule: ServerModule = {
  name: 'teams-access',
  register: async (app) => {
    await app.register(fastifyWebsocket);
    lastScope = app;
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/probe/tenant', async (request) => ({ tenantId: request.tenant.tenantId }));
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.post('/probe/write', { preHandler: requireUser }, async (request) => ({ via: request.caller?.via }));
    app.get('/probe/socket', { websocket: true }, (socket, request) => {
      socket.send(request.tenant.tenantId);
      socket.close();
    });
  },
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.registerPublic is async
  registerPublic: async (app) => {
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/hooks-probe', async (request) => ({ tenantId: request.tenant.tenantId }));
  },
};

/** The first frame of an upgrade sent with `host`; the listener is on before the socket opens. */
async function firstMessage(app: IdentityHarness['app'], host: string): Promise<string> {
  let received!: Promise<string>;
  await socketScopes.get(app)!.injectWS(
    '/api/v1/probe/socket',
    { headers: { host } },
    {
      onInit: (socket) => {
        received = new Promise((resolve) => {
          socket.once('message', (data: Buffer) => {
            resolve(data.toString('utf8'));
          });
        });
      },
    },
  );
  return received;
}

const tenantOf = async (app: IdentityHarness['app'], host: string, headers: Record<string, string> = {}) =>
  app.inject({ method: 'GET', url: '/api/v1/probe/tenant', headers: { host, ...headers } });

describeDb('tenant resolution (spec §19.5)', () => {
  describe('self-hosted', () => {
    let h: IdentityHarness;
    let defaultId: string;
    beforeAll(async () => {
      h = await identityHarness({
        env: { ...BROWSER_ENV, ...OIDC_ENV, WIREBENCH_SERVER_TRUST_PROXY: 'true' },
        provider,
        modules: [probeModule],
      });
      socketScopes.set(h.app, lastScope!);
      defaultId = (await h.db.query<{ id: string }>('select default_tenant_id::text as id from server_identity'))
        .rows[0]!.id;
      // A second tenant whose name a hostile Host could spell: self-hosted mode must never pick it.
      await h.db.query(`insert into tenants (id, slug, name) values (gen_random_uuid(), 'acme', 'Acme')`);
    });
    afterAll(() => h.close());

    it('serves the default tenant whatever Host or X-Forwarded-Host says', async () => {
      for (const host of ['wirebench.test', 'acme.example.test', 'ACME.example.test:443', 'evil.test', '', '[::1]']) {
        const res = await tenantOf(h.app, host, { 'x-forwarded-host': 'acme.example.test' });
        expect(res.statusCode, host).toBe(200);
        expect(res.json(), host).toEqual({ tenantId: defaultId });
      }
    });

    it('gives the public routes and WebSocket upgrades the default tenant, and /healthz none', async () => {
      const root = await h.app.inject({ method: 'GET', url: '/hooks-probe', headers: { host: 'acme.example.test' } });
      expect(root.json()).toEqual({ tenantId: defaultId });
      expect(await firstMessage(h.app, 'acme.example.test')).toBe(defaultId);
      const health = await h.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'anything.test' } });
      expect([200, 503]).toContain(health.statusCode);
    });

    it('offers OIDC as configured: the starts answer, only hosted mode turns them off', async () => {
      const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta' });
      expect(meta.json<{ auth: Record<string, unknown> }>().auth).toMatchObject({ oidc: true });
      expect((await h.app.inject(OIDC_ROUTES[0]!)).statusCode).toBe(201);
      expect((await h.app.inject({ method: 'GET', url: '/sign-in/oidc' })).statusCode).toBe(302);
    });

    it('names the public URL, never a slug, and checks cookies and Origin against it', async () => {
      const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: 'acme.example.test' } });
      expect(meta.json<{ publicUrl: string }>().publicUrl).toBe(PUBLIC_URL);
      expect(meta.body).not.toContain('acme');
      const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
      const post = (origin: string) =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/probe/write',
          headers: { host: 'acme.example.test', origin, cookie: `__Host-wb_session=${alice.token}` },
        });
      expect((await post('https://acme.example.test')).statusCode).toBe(403);
      expect((await post(PUBLIC_URL)).json()).toEqual({ via: 'cookie' });
    });
  });

  describe('hosted', () => {
    let h: IdentityHarness;
    let resolver: TenantResolver | undefined;
    const ids: Record<string, string> = {};
    beforeAll(async () => {
      h = await identityHarness({
        env: { ...BROWSER_ENV, ...OIDC_ENV },
        provider,
        modules: [probeModule],
        configure: hosted,
        beforeBuild: async (db, ctx) => {
          for (const slug of ['acme', 'paused', 'gone']) {
            const created = await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({ slug, name: slug });
            ids[slug] = created.scope.tenantId;
          }
          await db.query(`update tenants set status = 'suspended' where slug = 'paused'`);
          await db.query(`update tenants set status = 'deleting' where slug = 'gone'`);
          ids.default = directoryOf(ctx.tenancy).defaultScope().tenantId;
        },
        onTenantResolver: (r) => {
          resolver = r;
        },
      });
      socketScopes.set(h.app, lastScope!);
    });
    afterAll(() => h.close());

    it('resolves acme.example.test, in any case and with a port', async () => {
      for (const host of ['acme.example.test', 'ACME.example.test:443', 'acme.Example.Test.']) {
        const res = await tenantOf(h.app, host);
        expect(res.statusCode, host).toBe(200);
        expect(res.json(), host).toEqual({ tenantId: ids.acme });
      }
    });

    it('answers 404 with an empty, uncached body for every other name', async () => {
      const refused = [
        'unknown.example.test',
        'two.labels.example.test',
        'acme.example.test.evil.test',
        'example.test',
        'default.example.test',
        'paused.example.test',
        'gone.example.test',
        'wirebench.test',
        'acme',
        '',
      ];
      for (const host of refused) {
        for (const url of ['/api/v1/probe/tenant', '/api/v1/meta', '/hooks-probe', '/sign-in', '/no-such-route']) {
          const res = await h.app.inject({ method: 'GET', url, headers: { host } });
          expect(res.statusCode, `${host} ${url}`).toBe(404);
          expect(res.body, `${host} ${url}`).toBe('');
          expect(res.headers['cache-control'], `${host} ${url}`).toBe('no-store');
        }
      }
    });

    it('counts X-Forwarded-Host only with trustProxy', async () => {
      const res = await tenantOf(h.app, 'unknown.example.test', { 'x-forwarded-host': 'acme.example.test' });
      expect(res.statusCode).toBe(404);
      const forged = await tenantOf(h.app, 'acme.example.test', { 'x-forwarded-host': 'unknown.example.test' });
      expect(forged.json()).toEqual({ tenantId: ids.acme });
    });

    it('scopes the public routes and WebSocket upgrades, and leaves /healthz unscoped', async () => {
      const root = await h.app.inject({ method: 'GET', url: '/hooks-probe', headers: { host: 'acme.example.test' } });
      expect(root.json()).toEqual({ tenantId: ids.acme });
      expect(await firstMessage(h.app, 'acme.example.test')).toBe(ids.acme);
      await expect(firstMessage(h.app, 'unknown.example.test')).rejects.toThrow('404');
      const health = await h.app.inject({ method: 'GET', url: '/healthz', headers: { host: 'unknown.example.test' } });
      expect([200, 503]).toContain(health.statusCode);
    });

    it("prints and checks the tenant's URL: meta, the cookie and Origin", async () => {
      const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: 'acme.example.test' } });
      expect(meta.json<{ publicUrl: string }>().publicUrl).toBe('https://acme.example.test');
      const alice = await signedInUser(h, { email: 'alice@example.com', kind: 'browser' });
      const post = (origin: string, cookie = '__Host-wb_session') =>
        h.app.inject({
          method: 'POST',
          url: '/api/v1/probe/write',
          headers: { host: 'acme.example.test', origin, cookie: `${cookie}=${alice.token}` },
        });
      // The configured public URL is no tenant's origin in hosted mode.
      for (const origin of [PUBLIC_URL, 'https://other.example.test', 'http://acme.example.test']) {
        const res = await post(origin);
        expect(res.statusCode, origin).toBe(403);
        expect(res.json<{ code: string }>().code).toBe('identity-origin-refused');
      }
      expect((await post('https://acme.example.test')).json()).toEqual({ via: 'cookie' });
      // An https tenant URL: the cookie is the `__Host-` one, set `Secure`.
      const out = await h.app.inject({
        method: 'POST',
        url: '/sign-out',
        headers: {
          host: 'acme.example.test',
          origin: 'https://acme.example.test',
          cookie: `__Host-wb_session=${alice.token}`,
          'content-type': 'application/x-www-form-urlencoded',
        },
        payload: '',
      });
      expect(out.statusCode).toBe(303);
      expect(String(out.headers['set-cookie'])).toMatch(/^__Host-wb_session=; .*; Secure; SameSite=Lax$/);
      const refused = await h.app.inject({
        method: 'POST',
        url: '/sign-out',
        headers: { host: 'acme.example.test', origin: PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
        payload: '',
      });
      expect(refused.statusCode).toBe(403);
    });

    it('answers 404 on every OIDC route and reports no OIDC, though the operator configured it (spec §19.1)', async () => {
      for (const route of OIDC_ROUTES) {
        const res = await h.app.inject({ ...route, headers: { host: 'acme.example.test' } });
        expect(res.statusCode, route.url).toBe(404);
        expect(res.json<{ code: string }>().code, route.url).toBe('identity-method-disabled');
      }
      const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: 'acme.example.test' } });
      expect(meta.json<{ auth: Record<string, unknown> }>().auth).toMatchObject({ local: true, oidc: false });
      expect(meta.body).not.toContain('oidcDisplayName');
    });

    it("names the tenant's URL in an invitation link", async () => {
      const admin = await signedInUser(h, { email: 'admin@example.com', serverAdmin: true });
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/invitations',
        headers: { host: 'acme.example.test', ...admin.headers },
        payload: { email: 'new@example.com' },
      });
      expect(res.statusCode).toBe(201);
      expect(res.json<{ url: string }>().url).toMatch(/^https:\/\/acme\.example\.test\/invite\//);
    });

    it('picks up a tenant written behind the directory on invalidate(), and drops a suspended one', async () => {
      expect(resolver).toBeDefined();
      expect((await tenantOf(h.app, 'later.example.test')).statusCode).toBe(404);
      await h.db.query(`insert into tenants (id, slug, name) values (gen_random_uuid(), 'later', 'Later')`);
      // A write outside the directory waits for the poll, or an invalidate().
      expect((await tenantOf(h.app, 'later.example.test')).statusCode).toBe(404);
      await resolver!.invalidate();
      const later = await tenantOf(h.app, 'later.example.test');
      expect(later.statusCode).toBe(200);
      const id = (await h.db.query<{ id: string }>(`select id::text as id from tenants where slug = 'later'`)).rows[0]!
        .id;
      expect(later.json()).toEqual({ tenantId: id });
      await h.db.query(`update tenants set status = 'suspended' where slug = 'later'`);
      await resolver!.invalidate();
      expect((await tenantOf(h.app, 'later.example.test')).statusCode).toBe(404);
    });
  });
});
