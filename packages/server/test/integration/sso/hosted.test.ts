/**
 * SAML and SCIM in hosted mode (hosted edition spec §22.1, §22.12): every route is served, but a tenant's SAML is its
 * own setting, so a tenant without one answers each SAML route as a server without SAML does (`404`
 * `identity-method-disabled`), even with the environment's SAML variables set: the operator's one IdP would sign
 * people into every tenant, which is why `perTenantSettingProblems` refuses those variables in hosted mode. The SCIM
 * base and its admin routes answer per tenant. `settings/sign-in.test.ts` runs the flows with a provider per tenant.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { perTenantSettingProblems, type ServerConfig } from '../../../src/config.js';
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

/** Every SAML route, desktop and browser. */
const SAML_ROUTES: readonly {
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
  { method: 'GET', url: '/sign-in/saml' },
];

const send = (h: IdentityHarness, route: (typeof SAML_ROUTES)[number]) =>
  h.app.inject({
    method: route.method,
    url: route.url,
    headers: { host: HOST, ...(route.type !== undefined ? { 'content-type': route.type } : {}) },
    ...(route.payload !== undefined ? { payload: route.payload } : {}),
  });

describeDb('SAML and SCIM in hosted mode (spec §22.12)', () => {
  let h: IdentityHarness;
  beforeAll(async () => {
    h = await identityHarness({
      env: ENV,
      modules: (clock) => [
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0, metadata: parseIdpMetadata(idpMetadata()) }),
      ],
      configure: hosted,
      beforeBuild: async (db, ctx) => {
        await new TenantAdmin(db, directoryOf(ctx.tenancy)).create({ slug: 'acme', name: 'Acme' });
      },
    });
  }, 60_000);
  afterAll(() => h.close());

  it('answers every SAML route of a tenant without settings as a server without SAML, whatever the environment', async () => {
    for (const route of SAML_ROUTES) {
      const res = await send(h, route);
      expect(res.statusCode, `${route.method} ${route.url}`).toBe(404);
      if (!route.url.startsWith('/sign-in'))
        expect(res.json(), route.url).toMatchObject({ code: 'identity-method-disabled' });
    }
    const meta = await h.app.inject({ method: 'GET', url: '/api/v1/meta', headers: { host: HOST } });
    expect(meta.json<{ auth: Record<string, unknown> }>().auth).toEqual({ local: true, oidc: false });
  });

  it('serves the SCIM base and its admin routes, which refuse without a token or a session', async () => {
    const scim = await h.app.inject({ method: 'GET', url: '/scim/v2/Users', headers: { host: HOST } });
    expect(scim.statusCode).toBe(401);
    const tokens = await h.app.inject({ method: 'GET', url: '/api/v1/scim-tokens', headers: { host: HOST } });
    expect(tokens.statusCode).toBe(401);
  });

  it('refuses the environment’s identity and forwarding variables, by name, with control-plane-setting-per-tenant', () => {
    const problems = perTenantSettingProblems(
      { mode: 'hosted' },
      {
        ...ENV,
        WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test',
        WIREBENCH_SERVER_AUDIT_FORWARD_URL: 'https://siem.test',
        WIREBENCH_SERVER_AUDIT_FORWARD_TOKEN: '',
      },
    );
    expect(problems.map((problem) => problem.variable).sort()).toEqual([
      'WIREBENCH_SERVER_AUDIT_FORWARD_URL',
      'WIREBENCH_SERVER_OIDC_ISSUER',
      'WIREBENCH_SERVER_SAML_DISPLAY_NAME',
      'WIREBENCH_SERVER_SAML_IDP_METADATA',
    ]);
    for (const problem of problems) expect(problem.message).toMatch(/^control-plane-setting-per-tenant: /);
    expect(JSON.stringify(problems)).not.toContain('siem.test');
    expect(perTenantSettingProblems({ mode: 'self-hosted' }, ENV)).toEqual([]);
  });
});
