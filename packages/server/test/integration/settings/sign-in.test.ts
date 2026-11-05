/**
 * Slice 7 Task 26 (hosted edition spec §22.12, §19.12's promise): OIDC, SAML and SCIM per tenant, end to end through
 * the routes. Acme and beta each have their own identity provider in their settings; a sign-in completes on its own
 * tenant's host against its own provider only, a provider's answer is refused by the other tenant, a SCIM token
 * provisions its own tenant only, and a tenant with no settings answers as a server without the method.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { licensingModule } from '../../../src/licensing/module.js';
import { pkceChallenge } from '../../../src/identity/tokens.js';
import { ssoModule } from '../../../src/sso/module.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import type { SignedInUser } from '../../helpers/identity.js';
import { testKeys } from '../../helpers/licensing.js';
import {
  EMAIL_CLAIM,
  IDP_CERT,
  IDP_KEY,
  OTHER_CERT,
  OTHER_KEY,
  encode,
  idpMetadata,
  readAuthorizationUrl,
  signedResponse,
} from '../../helpers/saml-idp.js';
import { setEdition, twoTenants, type Tenant, type TwoTenants } from '../tenancy/modules/two-tenants.js';

const keys = testKeys();
const VERIFIER = 'v'.repeat(43);
const PORT = 49152;
const ENV = {
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
  // The fake issuers are http:// on loopback: the development switch, as the self-hosted OIDC suites use it.
  WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
};
const SAML_ENTITY = { acme: 'https://idp.acme.test/saml', beta: 'https://idp.beta.test/saml' } as const;
const SAML_KEY = { acme: IDP_KEY, beta: OTHER_KEY } as const;

describeDb('sign-in and provisioning per tenant, through the routes (spec §22.12)', () => {
  let t: TwoTenants;
  const idps: Partial<Record<'acme' | 'beta', FakeOidcIssuer>> = {};
  const admins: Partial<Record<'acme' | 'beta', SignedInUser>> = {};
  const idp = (tenant: Tenant) => idps[tenant.slug]!;

  beforeAll(async () => {
    t = await twoTenants({
      env: ENV,
      identity: { oidcEgress: 'unchecked' },
      modules: (clock) => [
        licensingModule({ now: () => clock.now, publicKeys: [keys.publicKey] }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0 }),
      ],
    });
    for (const tenant of [t.a, t.b]) {
      await setEdition(t, tenant, 'enterprise');
      admins[tenant.slug] = await tenant.user({ email: `root@${tenant.slug}.test`, serverAdmin: true });
      // The same address in both tenants: a provider's verified email must link only in its own.
      await tenant.user({ email: 'ada@example.com' });
      idps[tenant.slug] = await startFakeOidcIssuer({
        clientId: `${tenant.slug}-client`,
        clientSecret: `${tenant.slug}-client-secret-0123456789`,
      });
    }
  }, 120_000);
  afterAll(async () => {
    await t.close();
    for (const issuer of Object.values(idps)) await issuer.close();
  });

  const oidcStart = (tenant: Tenant) =>
    tenant.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/start',
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: PORT },
    });
  const samlStart = (tenant: Tenant) =>
    tenant.inject({
      method: 'POST',
      url: '/api/v1/auth/saml/start',
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: PORT },
    });
  const meta = async (tenant: Tenant) =>
    (await tenant.inject({ method: 'GET', url: '/api/v1/meta' })).json<{ auth: Record<string, unknown> }>().auth;
  const loopback = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers['location']));

  it('a tenant without settings answers OIDC and SAML as a server without them', async () => {
    for (const tenant of [t.a, t.b]) {
      expect((await oidcStart(tenant)).json()).toMatchObject({ code: 'identity-method-disabled' });
      expect((await samlStart(tenant)).statusCode).toBe(404);
      expect(await meta(tenant)).toEqual({ local: true, oidc: false });
    }
  });

  describe('OIDC', () => {
    beforeAll(async () => {
      for (const tenant of [t.a, t.b]) {
        const issuer = idp(tenant);
        await t.h.ctx.settings.set(
          tenant.scope,
          'oidc',
          {
            issuer: issuer.url,
            clientId: issuer.clientId,
            clientSecret: issuer.clientSecret,
            displayName: `${tenant.slug} IdP`,
          },
          { by: 'test' },
        );
      }
    });

    /** Start → the tenant's IdP → its callback, on `tenant`'s host. */
    const signIn = async (tenant: Tenant) => {
      const started = await oidcStart(tenant);
      expect(started.statusCode, started.body).toBe(201);
      const { flowId, authorizationUrl } = started.json<{ flowId: string; authorizationUrl: string }>();
      return { flowId, authorizationUrl };
    };

    it('each tenant signs in through its own provider, and reports its own', async () => {
      for (const tenant of [t.a, t.b]) {
        expect(await meta(tenant)).toEqual({ local: true, oidc: true, oidcDisplayName: `${tenant.slug} IdP` });
        const { flowId, authorizationUrl } = await signIn(tenant);
        expect(authorizationUrl.startsWith(`${idp(tenant).url}/authorize?`)).toBe(true);
        expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
          `https://${tenant.host}/api/v1/auth/oidc/callback`,
        );
        idp(tenant).nextUser({ sub: `sub-${tenant.slug}`, email: 'ada@example.com', email_verified: true });
        const back = await idp(tenant).authorize(authorizationUrl);
        const cb = await tenant.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
        expect(cb.statusCode).toBe(302);
        const grant = loopback(cb).searchParams.get('grant');
        expect(grant, String(cb.headers['location'])).not.toBeNull();
        const done = await tenant.inject({
          method: 'POST',
          url: '/api/v1/auth/oidc/complete',
          payload: { flowId, grant, codeVerifier: VERIFIER },
        });
        expect(done.statusCode, done.body).toBe(201);
        const me = await tenant.inject({
          method: 'GET',
          url: '/api/v1/me',
          headers: { authorization: `Bearer ${done.json<{ token: string }>().token}` },
        });
        expect(me.json()).toMatchObject({
          user: { email: 'ada@example.com' },
          methods: { oidc: [{ issuer: idp(tenant).url }] },
        });
      }
    });

    it("the other tenant's provider is not trusted: its code fails on beta's client", async () => {
      // Beta's flow, carried to acme's IdP: acme's IdP mints a code for beta's callback, which beta's client
      // exchanges at beta's token endpoint, where that code means nothing.
      const { authorizationUrl } = await signIn(t.b);
      const carried = new URL(authorizationUrl);
      const forged = new URL(`${idp(t.a).url}/authorize${carried.search}`);
      idp(t.a).nextUser({ sub: 'sub-acme-2', email: 'ada@example.com', email_verified: true });
      const back = await idp(t.a).authorize(forged.href);
      const cb = await t.b.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
      expect(cb.statusCode).toBe(302);
      expect(loopback(cb).searchParams.get('error')).toBe('identity-oidc-failed');
      // And acme's callback, sent to beta's host, finds no flow there.
      const own = await signIn(t.a);
      const acmeBack = await idp(t.a).authorize(own.authorizationUrl);
      const crossed = await t.b.inject({ method: 'GET', url: `${acmeBack.pathname}${acmeBack.search}` });
      expect(crossed.statusCode).toBe(400);
    });

    it('a changed setting reaches the next sign-in, and a cleared one turns the method off', async () => {
      await t.h.ctx.settings.set(
        t.b.scope,
        'oidc',
        {
          issuer: idp(t.a).url,
          clientId: idp(t.a).clientId,
          clientSecret: idp(t.a).clientSecret,
          displayName: 'Moved',
        },
        { by: 'test' },
      );
      const { authorizationUrl } = await signIn(t.b);
      expect(authorizationUrl.startsWith(`${idp(t.a).url}/authorize?`)).toBe(true);
      await t.h.ctx.settings.clear(t.b.scope, 'oidc', { by: 'test' });
      expect((await oidcStart(t.b)).json()).toMatchObject({ code: 'identity-method-disabled' });
      expect(await meta(t.b)).toEqual({ local: true, oidc: false });
    });
  });

  describe('SAML', () => {
    beforeAll(async () => {
      for (const tenant of [t.a, t.b]) {
        await t.h.ctx.settings.set(
          tenant.scope,
          'saml',
          {
            idpMetadataXml: idpMetadata({
              entityId: SAML_ENTITY[tenant.slug],
              certs: [tenant.slug === 'acme' ? IDP_CERT : OTHER_CERT],
            }),
            displayName: `${tenant.slug} SSO`,
          },
          { by: 'test' },
        );
      }
    });

    const acsOf = (tenant: Tenant) => `https://${tenant.host}/api/v1/auth/saml/acs`;
    const entityOf = (tenant: Tenant) => `https://${tenant.host}/api/v1/auth/saml/metadata`;
    const response = (tenant: Tenant, issuerOf: Tenant, requestId: string) =>
      encode(
        signedResponse(
          {
            inResponseTo: requestId,
            audience: entityOf(tenant),
            recipient: acsOf(tenant),
            destination: acsOf(tenant),
            now: new Date(),
            issuer: SAML_ENTITY[issuerOf.slug],
            nameId: `ada-${issuerOf.slug}`,
            attributes: { [EMAIL_CLAIM]: 'ada@example.com' },
          },
          { key: SAML_KEY[issuerOf.slug] },
        ),
      );
    const acs = (tenant: Tenant, samlResponse: string, relayState: string) =>
      tenant.inject({
        method: 'POST',
        url: '/api/v1/auth/saml/acs',
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
      });

    it('each tenant signs in through its own IdP, with its own entity ID', async () => {
      for (const tenant of [t.a, t.b]) {
        expect(await meta(tenant)).toMatchObject({ saml: true, samlDisplayName: `${tenant.slug} SSO` });
        const started = await samlStart(tenant);
        expect(started.statusCode, started.body).toBe(201);
        const { flowId, authorizationUrl } = started.json<{ flowId: string; authorizationUrl: string }>();
        const request = readAuthorizationUrl(authorizationUrl);
        expect(request.xml).toContain(entityOf(tenant));
        const posted = await acs(tenant, response(tenant, tenant, request.id), request.relayState);
        const grant = loopback(posted).searchParams.get('grant');
        expect(grant, String(posted.headers['location'])).not.toBeNull();
        const done = await tenant.inject({
          method: 'POST',
          url: '/api/v1/auth/saml/complete',
          payload: { flowId, grant, codeVerifier: VERIFIER },
        });
        expect(done.statusCode, done.body).toBe(201);
        const metadata = await tenant.inject({ method: 'GET', url: '/api/v1/auth/saml/metadata' });
        expect(metadata.body).toContain(entityOf(tenant));
      }
    });

    it("acme's IdP's assertion is refused by beta, even made out to beta", async () => {
      const started = await samlStart(t.b);
      const request = readAuthorizationUrl(started.json<{ authorizationUrl: string }>().authorizationUrl);
      const posted = await acs(t.b, response(t.b, t.a, request.id), request.relayState);
      expect(loopback(posted).searchParams.get('error')).toMatch(/^saml-/);
    });
  });

  describe('SCIM', () => {
    it("each tenant's token provisions its own tenant only", async () => {
      const tokens: Partial<Record<'acme' | 'beta', string>> = {};
      for (const tenant of [t.a, t.b]) {
        const made = await tenant.call<{ token: string }>(admins[tenant.slug], 'POST', '/scim-tokens', { name: 'idp' });
        expect(made.status).toBe(201);
        tokens[tenant.slug] = made.body.token;
      }
      const scim = (tenant: Tenant, token: string, method: 'GET' | 'POST', url: string, payload?: object) =>
        tenant.inject({
          method,
          url: `/scim/v2${url}`,
          headers: { authorization: `Bearer ${token}`, 'content-type': 'application/scim+json' },
          ...(payload !== undefined ? { payload } : {}),
        });
      const created = await scim(t.a, tokens.acme!, 'POST', '/Users', {
        schemas: ['urn:ietf:params:scim:schemas:core:2.0:User'],
        userName: 'grace@example.com',
        emails: [{ value: 'grace@example.com', primary: true }],
        active: true,
      });
      expect(created.statusCode, created.body).toBe(201);
      // Acme's token is unknown on beta's host, and beta's list has no grace.
      expect((await scim(t.b, tokens.acme!, 'GET', '/Users')).statusCode).toBe(401);
      const listed = await scim(t.b, tokens.beta!, 'GET', '/Users?filter=userName%20eq%20%22grace%40example.com%22');
      expect(listed.statusCode).toBe(200);
      expect(listed.json<{ totalResults: number }>().totalResults).toBe(0);
      const own = await scim(t.a, tokens.acme!, 'GET', '/Users?filter=userName%20eq%20%22grace%40example.com%22');
      expect(own.json<{ totalResults: number }>().totalResults).toBe(1);
    });
  });
});
