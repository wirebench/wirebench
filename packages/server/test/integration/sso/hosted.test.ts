/**
 * Hosted mode serves no SAML route, desktop or browser, no SCIM base and no SCIM admin route, for any tenant (hosted edition spec
 * §19.1): until slice 7 gives each tenant its own identity provider, the operator's one would sign people into
 * every tenant. A self-hosted server with the same configuration answers every one of them, so a `404` there is
 * the route's absence, not a refusal.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import type { ServerConfig } from '../../../src/config.js';
import { ssoModule } from '../../../src/sso/module.js';
import { parseIdpMetadata } from '../../../src/sso/saml-metadata.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, type IdentityHarness } from '../../helpers/identity.js';
import { idpMetadata } from '../../helpers/saml-idp.js';

const ENV = {
  WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/wirebench/idp-metadata.xml',
  WIREBENCH_SERVER_SAML_DISPLAY_NAME: 'Example SSO',
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};
const HOST = 'acme.example.test';
const hosted = (config: ServerConfig): ServerConfig => ({ ...config, mode: 'hosted', appDomain: 'example.test' });

/** Every SAML route (desktop and browser) and a sample of the SCIM base. */
const ROUTES: readonly {
  readonly method: 'GET' | 'POST';
  readonly url: string;
  readonly payload?: string | object;
  readonly type?: string;
}[] = [
  {
    method: 'POST',
    url: '/api/v1/auth/saml/start',
    payload: { device: { name: 'Mac' }, codeChallenge: 'c'.repeat(43), loopbackPort: 49152 },
  },
  {
    method: 'POST',
    url: '/api/v1/auth/saml/acs',
    payload: 'SAMLResponse=x&RelayState=y',
    type: 'application/x-www-form-urlencoded',
  },
  {
    method: 'POST',
    url: '/api/v1/auth/saml/browser-acs',
    payload: 'SAMLResponse=x&RelayState=y',
    type: 'application/x-www-form-urlencoded',
  },
  {
    method: 'POST',
    url: '/api/v1/auth/saml/complete',
    payload: { flowId: '01J9ZK3V8Q00000000000000F1', grant: 'g'.repeat(43), codeVerifier: 'v'.repeat(43) },
  },
  { method: 'GET', url: '/api/v1/auth/saml/metadata' },
  { method: 'GET', url: '/api/v1/auth/saml/info' },
  { method: 'GET', url: '/sign-in/saml' },
  { method: 'GET', url: '/scim/v2/Users' },
  { method: 'GET', url: '/scim/v2/ServiceProviderConfig' },
  { method: 'POST', url: '/scim/v2/Users', payload: { userName: 'ada@example.com' } },
  // The SCIM admin routes go with the base they manage (Task 15 review M2).
  { method: 'GET', url: '/api/v1/scim-tokens' },
  { method: 'POST', url: '/api/v1/scim-tokens', payload: { name: 'idp' } },
  { method: 'GET', url: '/api/v1/scim-groups' },
];

const send = (h: IdentityHarness, route: (typeof ROUTES)[number]) =>
  h.app.inject({
    method: route.method,
    url: route.url,
    headers: { host: HOST, ...(route.type !== undefined ? { 'content-type': route.type } : {}) },
    ...(route.payload !== undefined ? { payload: route.payload } : {}),
  });

const modules = (clock: { readonly now: Date }) => [
  ssoModule({ now: () => clock.now, sweepIntervalMs: 0, metadata: parseIdpMetadata(idpMetadata()) }),
];

describeDb('SAML and SCIM in hosted mode (spec §19.1)', () => {
  describe('self-hosted, the same configuration', () => {
    let h: IdentityHarness;
    beforeAll(async () => {
      h = await identityHarness({ env: ENV, modules });
    });
    afterAll(() => h.close());

    it('serves every route', async () => {
      for (const route of ROUTES) {
        const res = await send(h, route);
        expect(res.statusCode, `${route.method} ${route.url}`).not.toBe(404);
      }
    });
  });

  describe('hosted', () => {
    let h: IdentityHarness;
    beforeAll(async () => {
      h = await identityHarness({
        env: ENV,
        modules,
        configure: hosted,
        beforeBuild: async (db, ctx) => {
          await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
        },
      });
    });
    afterAll(() => h.close());

    it('answers 404 on every SAML and SCIM route of a tenant it resolves', async () => {
      // The tenant resolves: a route of the API answers on its host.
      const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: HOST } });
      expect(meta.statusCode).toBe(200);
      for (const route of ROUTES) {
        const res = await send(h, route);
        expect(res.statusCode, `${route.method} ${route.url}`).toBe(404);
      }
    });
  });
});
