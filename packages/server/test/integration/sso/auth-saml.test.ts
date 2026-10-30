import { Writable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { SYSTEM_SOURCE, permissiveLicense } from '../../../src/context.js';
import { createInvitation } from '../../../src/identity/invitations.js';
import { pkceChallenge } from '../../../src/identity/tokens.js';
import * as repo from '../../../src/sso/repo.js';
import { ssoModule } from '../../../src/sso/module.js';
import { parseIdpMetadata } from '../../../src/sso/saml-metadata.js';
import { expectNoSecretsInAudit } from '../../helpers/context.js';
import { describeDb } from '../../helpers/database.js';
import { signedInUser, type IdentityHarness, type SignedInUser } from '../../helpers/identity.js';
import { license, licensingHarness, testKeys } from '../../helpers/licensing.js';
import {
  EMAIL_CLAIM,
  IDP_ENTITY_ID,
  alterAttribute,
  encode,
  idpMetadata,
  readAuthorizationUrl,
  signedResponse,
  type ResponseInput,
} from '../../helpers/saml-idp.js';

const VERIFIER = 'v'.repeat(43);
const PORT = 49152;
const ENTITY_ID = 'https://wirebench.test/api/v1/auth/saml/metadata';
const ACS = 'https://wirebench.test/api/v1/auth/saml/acs';
const SAML_ENV = {
  // Absolute, so configuration accepts it; the module is handed the parsed metadata instead of reading it.
  WIREBENCH_SERVER_SAML_IDP_METADATA: '/etc/wirebench/idp-metadata.xml',
  WIREBENCH_SERVER_SAML_DISPLAY_NAME: 'Example SSO',
};

/** Collects the server's log lines, to prove no response or grant reaches them. */
function logSink(): { stream: Writable; text: () => string } {
  const chunks: string[] = [];
  return {
    stream: new Writable({
      write(chunk: Buffer, _encoding, done) {
        chunks.push(chunk.toString('utf8'));
        done();
      },
    }),
    text: () => chunks.join(''),
  };
}

describeDb('SAML sign-in (saml-scim spec §3.2, §3.3, §6.1)', () => {
  const keys = testKeys();
  let h: IdentityHarness;
  let admin: SignedInUser;
  let logs: ReturnType<typeof logSink>;

  const boot = async (options: { saml?: boolean; licensed?: boolean; seats?: number } = {}) => {
    logs = logSink();
    h = await licensingHarness(keys, {
      env: { ...(options.saml === false ? {} : SAML_ENV), WIREBENCH_SERVER_LOG_LEVEL: 'info' },
      logStream: logs.stream,
      extra: (clock) => [
        auditLogModule({ now: () => clock.now }),
        ssoModule({ now: () => clock.now, sweepIntervalMs: 0, metadata: parseIdpMetadata(idpMetadata()) }),
      ],
    });
    admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    if (options.licensed !== false) {
      const put = await h.app.inject({
        method: 'PUT',
        url: '/api/v1/license',
        headers: admin.headers,
        payload: {
          license: license(keys, {
            edition: 'enterprise',
            ...(options.seats !== undefined ? { seats: options.seats } : {}),
          }),
        },
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
          tenancy: h.ctx.tenancy,
          config: { publicUrl: 'https://wirebench.test' },
          hooks: h.hooks,
          license: permissiveLicense(),
        },
        settings: { invitationMs: 7 * 86_400_000 },
        now: () => h.clock.now,
      } as never,
      h.tdb.scope,
      { email, serverAdmin: false, createdBy: null, source: SYSTEM_SOURCE, serverUrl: 'https://wirebench.test' },
    );
  const start = () =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/saml/start',
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: PORT },
    });
  /** Starts a flow and reads back the request ID and RelayState the IdP would see. */
  const started = async () => {
    const res = await start();
    expect(res.statusCode, res.body).toBe(201);
    const { flowId, authorizationUrl } = res.json<{ flowId: string; authorizationUrl: string }>();
    const request = readAuthorizationUrl(authorizationUrl);
    return { flowId, requestId: request.id, relayState: request.relayState };
  };
  /** A response as the IdP would sign it. node-saml reads the real clock, so the assertion is dated now. */
  const response = (requestId: string, overrides: Partial<ResponseInput> = {}) =>
    signedResponse({
      inResponseTo: requestId,
      audience: ENTITY_ID,
      recipient: ACS,
      destination: ACS,
      now: new Date(),
      ...overrides,
    });
  const acs = (samlResponse: string, relayState: string) =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/saml/acs',
      headers: { 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ SAMLResponse: samlResponse, RelayState: relayState }).toString(),
    });
  const loopback = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers['location']));
  const complete = (flowId: string, grant: string, codeVerifier = VERIFIER) =>
    h.app.inject({ method: 'POST', url: '/api/v1/auth/saml/complete', payload: { flowId, grant, codeVerifier } });
  const failures = async () =>
    (
      await h.db.query<{ details: { method: string; reason: string } }>(
        "select details from audit_events where action = 'auth.sign_in_failed' order by at, id",
      )
    ).rows.map((row) => row.details);

  /** Start → IdP → ACS for `overrides`, answering the ACS reply and the flow. */
  const throughAcs = async (overrides: Partial<ResponseInput> = {}) => {
    const flow = await started();
    const res = await acs(encode(response(flow.requestId, overrides)), flow.relayState);
    return { flow, res };
  };

  describe('licensed, SAML configured', () => {
    beforeEach(async () => {
      await boot();
    });

    it('meta reports SAML with its display name', async () => {
      expect((await h.app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).toMatchObject({
        auth: { saml: true, samlDisplayName: 'Example SSO' },
      });
    });

    it('start → IdP → ACS → complete signs an invited person in, links the identity and records method saml', async () => {
      await invite('ada@example.com');
      const { flow, res } = await throughAcs({
        nameId: 'ada-persistent-id',
        attributes: { [EMAIL_CLAIM]: 'Ada@Example.com', displayName: 'Ada Lovelace' },
      });
      expect(res.statusCode, res.body).toBe(302);
      const back = loopback(res);
      expect(back.origin).toBe(`http://127.0.0.1:${PORT}`);
      expect(back.searchParams.get('flow')).toBe(flow.flowId);
      const done = await complete(flow.flowId, back.searchParams.get('grant')!);
      expect(done.statusCode, done.body).toBe(201);
      const body = done.json<{ token: string; user: { id: string; email: string } }>();
      expect(body.user.email.toLowerCase()).toBe('ada@example.com');
      const me = await h.app.inject({
        method: 'GET',
        url: '/api/v1/me',
        headers: { authorization: `Bearer ${body.token}` },
      });
      expect(me.statusCode).toBe(200);
      expect(await repo.samlIdentityOf(h.db, IDP_ENTITY_ID, 'ada-persistent-id')).toMatchObject({
        userId: body.user.id,
      });
      const signedIn = await h.db.query<{ details: { method: string } }>(
        "select details from audit_events where action = 'auth.signed_in'",
      );
      expect(signedIn.rows.map((row) => row.details.method)).toEqual(['saml']);
      await expectNoSecretsInAudit(h.db);
      // §6.1: neither the response nor the grant reaches the log stream.
      expect(logs.text()).not.toContain(back.searchParams.get('grant')!);
      expect(logs.text()).not.toContain('SAMLResponse=');
    });

    it('a known identity signs in again without an invitation', async () => {
      await invite('ada@example.com');
      const first = await throughAcs({ nameId: 'ada-1', attributes: { [EMAIL_CLAIM]: 'ada@example.com' } });
      expect(first.res.statusCode).toBe(302);
      // The second time the IdP sends a new email: the persistent NameID is what links.
      const again = await throughAcs({ nameId: 'ada-1', attributes: { [EMAIL_CLAIM]: 'lovelace@example.com' } });
      const grant = loopback(again.res).searchParams.get('grant');
      expect(grant).not.toBeNull();
      expect((await complete(again.flow.flowId, grant!)).statusCode).toBe(201);
    });

    it('an existing user is linked by email', async () => {
      const bob = await signedInUser(h, { email: 'bob@example.com' });
      const { flow, res } = await throughAcs({ nameId: 'bob-1', attributes: { [EMAIL_CLAIM]: 'BOB@example.com' } });
      const done = await complete(flow.flowId, loopback(res).searchParams.get('grant')!);
      expect(done.json<{ user: { id: string } }>().user.id).toBe(bob.user.id);
    });

    it.each([
      ['an uninvited person', {}, 'identity-not-invited'],
      ['an assertion without an email', { attributes: {} }, 'identity-saml-no-email'],
      [
        'a transient NameID',
        { nameIdFormat: 'urn:oasis:names:tc:SAML:2.0:nameid-format:transient' },
        'identity-saml-transient-nameid',
      ],
      ['another audience', { audience: 'https://other.example.test' }, 'saml-audience'],
      ['another Recipient', { recipient: 'https://other.example.test/acs' }, 'saml-recipient'],
    ])('refuses %s, deletes the flow and records the reason', async (_name, overrides, reason) => {
      const { flow, res } = await throughAcs({
        nameId: 'eve-1',
        attributes: { [EMAIL_CLAIM]: 'eve@example.com' },
        ...overrides,
      });
      expect(res.statusCode).toBe(302);
      expect(loopback(res).searchParams.get('error')).toBe(reason);
      expect(await repo.samlFlowById(h.db, flow.flowId)).toBeUndefined();
      expect(await failures()).toEqual([expect.objectContaining({ method: 'saml', reason })]);
      await expectNoSecretsInAudit(h.db);
    });

    it('refuses an altered assertion as saml-signature, with nothing of the XML in the audit row', async () => {
      const flow = await started();
      const xml = alterAttribute(
        response(flow.requestId, { attributes: { [EMAIL_CLAIM]: 'ada@example.com' } }),
        'ada@example.com',
        'eve@example.com',
      );
      const res = await acs(encode(xml), flow.relayState);
      expect(loopback(res).searchParams.get('error')).toBe('saml-signature');
      const rows = await h.db.query<{ details: unknown }>(
        "select details from audit_events where action = 'auth.sign_in_failed'",
      );
      expect(JSON.stringify(rows.rows)).not.toMatch(/Assertion|eve@example/);
    });

    it('a disabled user is refused', async () => {
      await signedInUser(h, { email: 'dis@example.com', disabled: true });
      const { res } = await throughAcs({ nameId: 'dis-1', attributes: { [EMAIL_CLAIM]: 'dis@example.com' } });
      expect(loopback(res).searchParams.get('error')).toBe('identity-user-disabled');
    });

    it('the same response posted twice: the second finds the flow granted', async () => {
      await invite('ada@example.com');
      const flow = await started();
      const body = encode(response(flow.requestId, { attributes: { [EMAIL_CLAIM]: 'ada@example.com' } }));
      expect((await acs(body, flow.relayState)).statusCode).toBe(302);
      const replay = await acs(body, flow.relayState);
      expect(replay.statusCode).toBe(400);
      expect(replay.headers['content-type']).toMatch(/text\/html/);
    });

    it('a response for flow A posted with flow B’s RelayState is refused, and flow B is deleted', async () => {
      await invite('ada@example.com');
      const a = await started();
      const b = await started();
      const res = await acs(
        encode(response(a.requestId, { attributes: { [EMAIL_CLAIM]: 'ada@example.com' } })),
        b.relayState,
      );
      expect(loopback(res).searchParams.get('error')).toBe('saml-in-response-to');
      expect(await repo.samlFlowById(h.db, b.flowId)).toBeUndefined();
      expect(await repo.samlFlowById(h.db, a.flowId)).toBeDefined();
    });

    it('an unknown or expired RelayState gets the expired page', async () => {
      expect((await acs(encode('<x/>'), 'not-a-flow')).statusCode).toBe(400);
      const flow = await started();
      h.clock.advance(11 * 60_000);
      expect((await acs(encode(response(flow.requestId)), flow.relayState)).statusCode).toBe(400);
    });

    it('complete is single use and needs the verifier', async () => {
      await invite('ada@example.com');
      const { flow, res } = await throughAcs({ attributes: { [EMAIL_CLAIM]: 'ada@example.com' } });
      const grant = loopback(res).searchParams.get('grant')!;
      expect((await complete(flow.flowId, grant, 'w'.repeat(43))).statusCode).toBe(400);
      expect((await complete(flow.flowId, grant)).statusCode).toBe(201);
      expect((await complete(flow.flowId, grant)).statusCode).toBe(400);
    });

    it('refuses a body over 256 KiB before parsing it', async () => {
      const flow = await started();
      const res = await acs('A'.repeat(300 * 1024), flow.relayState);
      expect(res.statusCode).toBe(413);
    });

    it('serves SP metadata naming the entity ID and ACS', async () => {
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/auth/saml/metadata' });
      expect(res.statusCode).toBe(200);
      expect(res.headers['content-type']).toMatch(/samlmetadata\+xml/);
      expect(res.body).toContain(`entityID="${ENTITY_ID}"`);
      expect(res.body).toContain(`Location="${ACS}"`);
    });

    it('info is for server admins only', async () => {
      const member = await signedInUser(h, { email: 'm@example.com' });
      expect(
        (await h.app.inject({ method: 'GET', url: '/api/v1/auth/saml/info', headers: member.headers })).statusCode,
      ).toBe(403);
      const res = await h.app.inject({ method: 'GET', url: '/api/v1/auth/saml/info', headers: admin.headers });
      expect(res.json()).toEqual({
        configured: true,
        idpEntityId: IDP_ENTITY_ID,
        entityId: ENTITY_ID,
        acsUrl: ACS,
        scimBaseUrl: 'https://wirebench.test/scim/v2',
      });
    });
  });

  it('the seat limit refuses an invited person', async () => {
    await boot({ seats: 1 });
    await invite('ada@example.com');
    const { res } = await throughAcs({ attributes: { [EMAIL_CLAIM]: 'ada@example.com' } });
    expect(loopback(res).searchParams.get('error')).toBe('licensing-seat-limit');
  });

  it('an unlicensed server refuses start with licensing-feature-required', async () => {
    await boot({ licensed: false });
    const res = await start();
    expect(res.statusCode).toBe(403);
    expect(res.json()).toMatchObject({ code: 'licensing-feature-required' });
  });

  it('a server without SAML answers identity-method-disabled and meta leaves SAML out', async () => {
    await boot({ saml: false });
    const res = await start();
    expect(res.statusCode).toBe(404);
    expect(res.json()).toMatchObject({ code: 'identity-method-disabled' });
    const meta = (await h.app.inject({ method: 'GET', url: '/api/v1/meta' })).json<{ auth: object }>();
    expect(meta.auth).not.toHaveProperty('saml');
    const info = await h.app.inject({ method: 'GET', url: '/api/v1/auth/saml/info', headers: admin.headers });
    expect(info.json()).toMatchObject({ configured: false });
  });
});
