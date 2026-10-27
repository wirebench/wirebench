import { afterEach, describe, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { SYSTEM_SOURCE, permissiveLicense } from '../../../src/context.js';
import { createInvitation } from '../../../src/identity/invitations.js';
import * as identityRepo from '../../../src/identity/repo.js';
import { hashSecret } from '../../../src/identity/tokens.js';
import { ssoModule } from '../../../src/sso/module.js';
import { parseIdpMetadata } from '../../../src/sso/saml-metadata.js';
import { expectNoSecretsInAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import {
  EMAIL_CLAIM,
  IDP_SSO_URL,
  encode,
  idpMetadata,
  readAuthorizationUrl,
  signedResponse,
  type ResponseInput,
} from '../../helpers/saml-idp.js';

const ENTITY_ID = 'https://wirebench.test/api/v1/auth/saml/metadata';
const DESKTOP_ACS = 'https://wirebench.test/api/v1/auth/saml/acs';
const BROWSER_ACS = 'https://wirebench.test/api/v1/auth/saml/browser-acs';
const COOKIE = '__Host-wb_session';
const FLOW_COOKIE = '__Host-wb_flow';
const SAML_ENV = {
  WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/wirebench/idp-metadata.xml',
  WIREBENCH_SERVER_SAML_DISPLAY_NAME: 'Example <SSO>',
};
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

describeDb('SAML sign-in from the browser (hosted spec §17.2)', () => {
  const keys = testKeys();
  let h: IdentityHarness;

  const boot = async (options: { licensed?: boolean; browserClient?: boolean } = {}) => {
    h = await licensingHarness(keys, {
      env: { ...SAML_ENV, ...(options.browserClient === false ? {} : BROWSER_ENV) },
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0, metadata: parseIdpMetadata(idpMetadata()) }),
      ],
    });
    if (options.licensed !== false) {
      const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
      const put = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/license',
        headers: admin.headers,
        payload: { license: license(keys, { edition: 'enterprise' }) },
      });
      expect(put.statusCode, put.body).toBe(200);
    }
  };
  afterEach(async () => {
    await h.close();
  });

  const invite = (email: string) =>
    createInvitation(
      {
        ctx: {
          db: h.db,
          config: { publicUrl: 'https://wirebench.test' },
          hooks: h.hooks,
          license: permissiveLicense(),
        },
        settings: { invitationMs: 7 * 86_400_000 },
        now: () => h.clock.now,
      } as never,
      { email, serverAdmin: false, createdBy: null, source: SYSTEM_SOURCE },
    );
  /** `GET /sign-in/saml`, read back as the IdP would see it. */
  const start = async (query = '') => {
    const res = await h.app.inject({ method: 'GET', url: `/sign-in/saml${query}` });
    expect(res.statusCode, res.body).toBe(302);
    const location = String(res.headers['location']);
    return { res, location, request: readAuthorizationUrl(location), flowCookie: cookieValue(res, FLOW_COOKIE)! };
  };
  const response = (requestId: string, overrides: Partial<ResponseInput> = {}) =>
    signedResponse({
      inResponseTo: requestId,
      audience: ENTITY_ID,
      recipient: BROWSER_ACS,
      destination: BROWSER_ACS,
      now: new Date(),
      ...overrides,
    });
  const acs = (samlResponse: string, relayState: string, flowCookie: string | undefined) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/saml/browser-acs',
      headers: {
        'content-type': 'application/x-www-form-urlencoded',
        // The IdP's page posts the form, so the Origin is the IdP's.
        origin: 'https://idp.example.test',
        ...(flowCookie !== undefined ? { cookie: `${FLOW_COOKIE}=${flowCookie}` } : {}),
      },
      payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
    });

  describe('licensed, with the browser client on', () => {
    it('the sign-in page lists SSO under its escaped display name', async () => {
      await boot();
      const page = await h.app.inject({ method: 'GET', url: '/sign-in' });
      expect(page.body).toContain('href="/sign-in/saml"');
      expect(page.body).toContain('Example &lt;SSO&gt;');
    });

    it('start → IdP → browser ACS sets a browser session cookie and lands on redirect_to', async () => {
      await boot();
      await invite('ada@example.com');
      const { res, location, request, flowCookie } = await start('?redirect_to=%2Fw%2F2');
      expect(location.startsWith(`${IDP_SSO_URL}?`)).toBe(true);
      expect(request.xml).toContain(`AssertionConsumerServiceURL="${BROWSER_ACS}"`);
      expect(flowCookie).toBe(request.relayState);
      // The IdP posts the response cross-site, so the flow cookie must be SameSite=None.
      const flowLine = setCookies(res).find((l) => l.startsWith(`${FLOW_COOKIE}=`))!;
      expect(flowLine).toContain('SameSite=None');
      expect(flowLine).toContain('Secure');
      const row = await h.db.query<{ provider: string; state_hash: string; nonce: string }>(
        'select * from browser_flows',
      );
      expect(row.rows).toMatchObject([
        { provider: 'saml', state_hash: hashSecret(request.relayState), nonce: request.id, redirect_to: '/w/2' },
      ]);

      const done = await acs(
        encode(response(request.id, { nameId: 'ada-1', attributes: { [EMAIL_CLAIM]: 'ada@example.com' } })),
        request.relayState,
        flowCookie,
      );
      expect(done.statusCode, done.body).toBe(303);
      expect(done.headers['location']).toBe('/w/2');
      const token = cookieValue(done, COOKIE)!;
      const me = await h.app.inject({ method: 'GET', url: '/api/v1/me', headers: { cookie: `${COOKIE}=${token}` } });
      expect(me.statusCode).toBe(200);
      const userId = me.json<{ user: { id: string } }>().user.id;
      expect((await identityRepo.tokensOfUser(h.db, userId)).map((t) => t.kind)).toEqual(['browser']);
      const signedIn = await h.db.query<{ details: { method: string } }>(
        "select details from audit_events where action = 'auth.signed_in'",
      );
      expect(signedIn.rows.map((r) => r.details.method)).toEqual(['saml']);
      expect((await h.db.query('select 1 from browser_flows')).rowCount).toBe(0);
      await expectNoSecretsInAudit(h.db);
    });

    it('refuses a replayed response', async () => {
      await boot();
      await invite('ada@example.com');
      const { request, flowCookie } = await start();
      const body = encode(response(request.id, { nameId: 'ada-1', attributes: { [EMAIL_CLAIM]: 'ada@example.com' } }));
      expect((await acs(body, request.relayState, flowCookie)).statusCode).toBe(303);
      const again = await acs(body, request.relayState, flowCookie);
      expect(again.statusCode).toBe(400);
      expect(cookieValue(again, COOKIE)).toBeUndefined();
    });

    it('refuses an expired flow', async () => {
      await boot();
      await invite('ada@example.com');
      const { request, flowCookie } = await start();
      h.clock.advance(10 * 60 * 1000 + 1);
      const res = await acs(
        encode(response(request.id, { nameId: 'ada-1', attributes: { [EMAIL_CLAIM]: 'ada@example.com' } })),
        request.relayState,
        flowCookie,
      );
      expect(res.statusCode).toBe(400);
      expect(cookieValue(res, COOKIE)).toBeUndefined();
    });

    it('refuses a response whose browser did not start the flow (login CSRF)', async () => {
      await boot();
      await invite('ada@example.com');
      const { request } = await start();
      const res = await acs(
        encode(response(request.id, { nameId: 'ada-1', attributes: { [EMAIL_CLAIM]: 'ada@example.com' } })),
        request.relayState,
        undefined,
      );
      expect(res.statusCode).toBe(400);
      expect(cookieValue(res, COOKIE)).toBeUndefined();
    });

    it('refuses a response addressed to the desktop ACS', async () => {
      await boot();
      await invite('ada@example.com');
      const { request, flowCookie } = await start();
      const res = await acs(
        encode(
          response(request.id, {
            recipient: DESKTOP_ACS,
            destination: DESKTOP_ACS,
            attributes: { [EMAIL_CLAIM]: 'ada@example.com' },
          }),
        ),
        request.relayState,
        flowCookie,
      );
      expect(res.statusCode).toBe(403);
      expect(cookieValue(res, COOKIE)).toBeUndefined();
      const failed = await h.db.query<{ details: { reason: string } }>(
        "select details from audit_events where action = 'auth.sign_in_failed'",
      );
      expect(failed.rows.map((r) => r.details.reason)).toEqual(['saml-recipient']);
    });

    it('the desktop start still names the desktop ACS', async () => {
      await boot();
      const res = await h.app.inject({
        method: 'POST',
        url: '/api/v1/auth/saml/start',
        payload: { device: { name: 'Mac' }, codeChallenge: 'c'.repeat(43), loopbackPort: 49152 },
      });
      expect(res.statusCode, res.body).toBe(201);
      const request = readAuthorizationUrl(res.json<{ authorizationUrl: string }>().authorizationUrl);
      expect(request.xml).toContain(`AssertionConsumerServiceURL="${DESKTOP_ACS}"`);
    });
  });

  it('an unlicensed server neither lists nor starts SAML', async () => {
    await boot({ licensed: false });
    const page = await h.app.inject({ method: 'GET', url: '/sign-in' });
    expect(page.body).not.toContain('/sign-in/saml');
    const res = await h.app.inject({ method: 'GET', url: '/sign-in/saml' });
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('licensing-feature-required');
  });

  it('serves neither the start nor the browser ACS with the browser client off', async () => {
    await boot({ browserClient: false });
    expect((await h.app.inject({ method: 'GET', url: '/sign-in/saml' })).statusCode).toBe(404);
    expect((await acs('x', 'y', undefined)).statusCode).toBe(404);
  });
});
