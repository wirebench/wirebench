/**
 * Two names, one tenant (hosted edition spec §23.5), end to end: acme claims `wb.customer.test`, the check passes on
 * a fake DNS and a stubbed certificate probe, and the name goes live. From then on the resolver maps it to acme's own
 * entry, beside `acme.example.test`; `tenantUrl` of a request is the host it came on, and the primary URL that mail and
 * links read is the custom name. Removing the claim moves the primary back. No real DNS: every name is under `.test`.
 */
import Fastify from 'fastify';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import type { DnsLookup } from '../../../src/custom-domains/dns.js';
import { openControlDb } from '../../../src/control-plane/control-db.js';
import { TenantLifecycle } from '../../../src/control-plane/tenants.js';
import { customDomainsModule } from '../../../src/custom-domains/module.js';
import { claim, removeClaim } from '../../../src/custom-domains/repo.js';
import { onPrimaryHost } from '../../../src/identity/browser-flows.js';
import { identitySettings } from '../../../src/identity/env.js';
import { sessionCookieName } from '../../../src/identity/cookies.js';
import { licensingModule } from '../../../src/licensing/module.js';
import { ssoUrls } from '../../../src/sso/env.js';
import { ensureControlRole } from '../../../src/tenancy/roles.js';
import { primaryUrl } from '../../../src/tenancy/urls.js';
import { describeDb } from '../../helpers/database.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { testKeys } from '../../helpers/licensing.js';
import { manualTimers } from '../../helpers/timers.js';
import { APP_DOMAIN, setEdition, twoTenants, type TwoTenants } from '../tenancy/modules/two-tenants.js';

const NAME = 'wb.customer.test';
const SLUG_URL = `https://acme.${APP_DOMAIN}`;
const CUSTOM_URL = `https://${NAME}`;
const keys = testKeys();
const notFound = () => Promise.reject(Object.assign(new Error('not found'), { code: 'ENOTFOUND' }));

describeDb('two names, one tenant (spec §23.5)', () => {
  let t: TwoTenants;
  let root: SignedInUser;
  let browser: SignedInUser;
  let certificate: 'ok' | 'missing' = 'missing';
  const txts = new Map<string, string[]>();
  const lookup: DnsLookup = {
    cname: (name) => (name === NAME ? Promise.resolve([`custom.${APP_DOMAIN}`]) : notFound()),
    a: notFound,
    aaaa: notFound,
    txt: (name) => {
      const values = txts.get(name);
      return values === undefined ? notFound() : Promise.resolve(values.map((value) => [value]));
    },
  };
  const on = (host: string, method: 'GET' | 'POST' | 'PUT' | 'DELETE', url: string, payload?: object) =>
    t.h.app.inject({ method, url, headers: { host, ...root.headers }, ...(payload !== undefined ? { payload } : {}) });
  const hosts = async () =>
    (await t.h.db.query<{ host: string; live: boolean }>('select host, live from tenant_hosts')).rows;

  beforeAll(async () => {
    t = await twoTenants({
      env: {
        WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
        WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
      },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        customDomainsModule({
          now: () => clock.now,
          lookup,
          probe: () => Promise.resolve({ verdict: certificate, message: `certificate ${certificate}` }),
          mail: null,
          setTimer: manualTimers().setTimer,
          allowTestNames: true,
        }),
      ],
    });
    await setEdition(t, t.a, 'enterprise');
    root = await t.a.user({ email: 'root@acme.test', serverAdmin: true });
    browser = await t.a.user({ email: 'tab@acme.test', kind: 'browser' });
    const claimed = await on(t.a.host, 'PUT', '/api/v1/tenant/domain', { name: NAME });
    expect(claimed.statusCode).toBe(200);
    const txt = claimed
      .json<{ records: { type: string; value: string }[] }>()
      .records.find((record) => record.type === 'TXT')!.value;
    txts.set(`_wirebench.${NAME}`, [txt]);
  });
  afterAll(() => t?.close());

  it('a verified name is held but not served: it answers 404 like any unknown host', async () => {
    const checked = await on(t.a.host, 'POST', '/api/v1/tenant/domain/check');
    expect(checked.json()).toMatchObject({ state: 'verified' });
    expect(await hosts()).toEqual([{ host: NAME, live: false }]);
    const res = await t.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: NAME } });
    expect(res.statusCode).toBe(404);
    expect(res.body).toBe('');
    expect(res.headers['cache-control']).toBe('no-store');
  });

  it('once the certificate is seen the name goes live, and the map picks it up without a manual reload', async () => {
    certificate = 'ok';
    t.h.clock.advance(60_000);
    const checked = await on(t.a.host, 'POST', '/api/v1/tenant/domain/check');
    expect(checked.json()).toMatchObject({ state: 'active' });
    expect(await hosts()).toEqual([{ host: NAME, live: true }]);
    await vi.waitFor(async () => {
      const res = await t.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: NAME } });
      expect(res.statusCode).toBe(200);
    });
  });

  it("tenantUrl of a request is the host it came on: /meta's public URL on each name", async () => {
    const custom = await t.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: 'WB.Customer.Test' } });
    expect(custom.json()).toMatchObject({ publicUrl: CUSTOM_URL });
    const slug = await t.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: t.a.host } });
    expect(slug.json()).toMatchObject({ publicUrl: SLUG_URL });
    // Beta is untouched: its slug host is its own, and the custom name is acme's alone.
    const beta = await t.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: t.b.host } });
    expect(beta.json()).toMatchObject({ publicUrl: `https://beta.${APP_DOMAIN}` });
  });

  it('the primary URL is the custom name: an invitation made on the slug host links it', async () => {
    const res = await on(t.a.host, 'POST', '/api/v1/invitations', { email: 'new@acme.test' });
    expect(res.statusCode).toBe(201);
    expect(res.json<{ url: string }>().url.startsWith(`${CUSTOM_URL}/invite/`)).toBe(true);
  });

  it("the identity provider's redirect URI is on the primary name, whichever name the request came on", () => {
    const settings = identitySettings(t.h.ctx.config);
    const request = { tenant: { ...t.a.scope, customHost: NAME } as typeof t.a.scope, hostname: t.a.host };
    expect(settings.redirectUri(request)).toBe(`${CUSTOM_URL}/api/v1/auth/oidc/callback`);
    expect(settings.browserRedirectUri(request)).toBe(`${CUSTOM_URL}/api/v1/auth/oidc/browser-callback`);
    expect(primaryUrl(t.h.ctx.config, request)).toBe(CUSTOM_URL);
  });

  it('a browser OIDC or SAML start on the slug host moves to the primary before any flow cookie, and the ACS is there', async () => {
    // Hosted mode serves no federated route yet (spec §19.1), so the starts' shared step runs on routes of its own.
    const app = Fastify();
    const tenant = { ...t.a.scope, customHost: NAME } as typeof t.a.scope;
    app.decorateRequest('tenant', {
      getter: () => tenant,
    });
    for (const path of ['/sign-in/oidc', '/sign-in/saml']) {
      app.get(path, (request, reply) => onPrimaryHost(t.h.ctx.config, request, reply) ?? reply.send('started'));
    }
    try {
      for (const path of ['/sign-in/oidc', '/sign-in/saml']) {
        const moved = await app.inject({ method: 'GET', url: `${path}?redirect_to=%2Fw`, headers: { host: t.a.host } });
        expect(moved.statusCode, path).toBe(302);
        expect(moved.headers.location, path).toBe(`${CUSTOM_URL}${path}?redirect_to=%2Fw`);
        expect(moved.headers['set-cookie'], path).toBeUndefined();
        const started = await app.inject({ method: 'GET', url: path, headers: { host: NAME } });
        expect(started.body, path).toBe('started');
      }
    } finally {
      await app.close();
    }
    const request = { tenant, hostname: t.a.host };
    expect(ssoUrls(primaryUrl(t.h.ctx.config, request)).browserAcsUrl).toBe(
      `${CUSTOM_URL}/api/v1/auth/saml/browser-acs`,
    );
  });

  it('removing a claim that holds nothing leaves the map alone', async () => {
    const removed = await t.b.tdb.transaction(async (tx) => {
      await claim(tx, { name: 'beta.customer.test', createdBy: null, now: t.h.clock.now });
      return removeClaim(tx);
    });
    expect(removed).toMatchObject({ name: 'beta.customer.test', released: false });
  });

  it("the Origin check on the custom name accepts its own origin and refuses the slug's", async () => {
    const write = (origin: string) =>
      t.h.app.inject({
        method: 'POST',
        url: '/sign-out',
        headers: { host: NAME, origin, cookie: `${sessionCookieName(CUSTOM_URL)}=${browser.token}` },
      });
    const refused = await write(SLUG_URL);
    expect(refused.statusCode).toBe(403);
    expect(refused.json()).toMatchObject({ code: 'identity-origin-refused' });
    expect((await write(CUSTOM_URL)).statusCode).toBe(303);
  });

  it("a suspended tenant's custom name answers exactly as its slug does, through slice 7's suspension", async () => {
    await ensureControlRole(t.h.db.owner, t.h.db.controlUrl, t.h.db.url);
    const control = openControlDb(t.h.db.controlUrl);
    const lifecycle = new TenantLifecycle({ control, tenancy: t.h.ctx.tenancy, hooks: t.h.hooks });
    try {
      await lifecycle.suspend('acme', 'unpaid');
      const both = (method: 'GET' | 'POST', url: string, headers: Record<string, string> = {}) =>
        Promise.all([
          t.h.app.inject({ method, url, headers: { host: t.a.host, ...headers } }),
          t.h.app.inject({ method, url, headers: { host: NAME, ...headers } }),
        ]);
      await vi.waitFor(async () => {
        const [slug, custom] = await both('GET', '/api/v1/me', root.headers);
        expect(slug.statusCode).toBe(403);
        expect(custom.statusCode).toBe(403);
        expect(custom.json()).toEqual(slug.json());
        expect(custom.json()).toMatchObject({ code: 'tenant-suspended', reason: 'unpaid' });
      });
      const [slugPage, customPage] = await both('GET', '/sign-in');
      expect(customPage.statusCode).toBe(slugPage.statusCode);
      expect(customPage.headers['content-type']).toBe(slugPage.headers['content-type']);
      expect(customPage.body).not.toMatch(/<form/i);
      const [slugHook, customHook] = await both('POST', '/hooks/anything');
      expect(slugHook.statusCode).toBe(503);
      expect(customHook.statusCode).toBe(503);
      expect(customHook.body).toBe('');

      await lifecycle.resume('acme');
      await vi.waitFor(async () => {
        const [, custom] = await both('GET', '/api/v1/me', root.headers);
        expect(custom.statusCode).toBe(200);
      });
    } finally {
      await control.close();
    }
  });

  it('removing the claim drops the name from the map and moves the primary back to the slug', async () => {
    expect((await on(t.a.host, 'DELETE', '/api/v1/tenant/domain')).statusCode).toBe(204);
    expect(await hosts()).toEqual([]);
    // The released row is what told the map.
    await vi.waitFor(async () => {
      const res = await t.h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: NAME } });
      expect(res.statusCode).toBe(404);
    });
    const res = await on(t.a.host, 'POST', '/api/v1/invitations', { email: 'later@acme.test' });
    expect(res.json<{ url: string }>().url.startsWith(`${SLUG_URL}/invite/`)).toBe(true);
  });
});
