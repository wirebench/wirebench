/**
 * Identity in a tenant (tenancy plan Task 8; spec §19.8, §19.13). Until `0021` forces the policy there is one
 * tenant, so the suite shows that every statement identity sends goes through the tenant database: the harness
 * registers identity with `scopedContext`, whose `ctx.db` throws, and the statement log shows each statement
 * after its unit's `set_config`. The sweep runs once per tenant through the job loop.
 */
import type { InjectOptions, LightMyRequestResponse } from 'fastify';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { SYSTEM_SOURCE } from '../../../src/context.js';
import { identitySettings } from '../../../src/identity/env.js';
import { createInvitation } from '../../../src/identity/invitations.js';
import * as repo from '../../../src/identity/repo.js';
import { SWEEP_JOB, sweepExpired } from '../../../src/identity/sessions.js';
import { mintToken, newId, pkceChallenge } from '../../../src/identity/tokens.js';
import { TenantAdmin } from '../../../src/tenancy/directory.js';
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';
import { expectAllScoped, expectNoRawStatementsOn } from '../../helpers/tenancy.js';

const PUBLIC_URL = 'https://wirebench.test';
const DAY = 86_400_000;
const VERIFIER = 'v'.repeat(43);
const PASSWORD = 'correct horse battery';

/** Identity's own tables: no statement on them may bypass the tenant database. */
const IDENTITY_TABLES = [
  'users',
  'local_credentials',
  'oidc_identities',
  'invitations',
  'device_tokens',
  'oidc_flows',
  'browser_flows',
];

describeDb('identity in a tenant (tenancy Task 8)', () => {
  let idp: FakeOidcIssuer;
  let h: IdentityHarness;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
    h = await identityHarness({
      env: {
        WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
        WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
  });
  afterEach(async () => {
    await h.close();
    await idp.close();
  });

  const inject = (
    method: NonNullable<InjectOptions['method']>,
    url: string,
    init: Pick<InjectOptions, 'headers' | 'payload'> = {},
  ): Promise<LightMyRequestResponse> => h.app.inject({ method, url, ...init });

  it('runs every statement of every route it serves inside a unit of the request’s tenant', async () => {
    const tenantId = h.tdb.scope.tenantId;
    const admin = await signedInUser(h, { email: 'admin@example.com', password: PASSWORD, serverAdmin: true });
    h.statements.entries.length = 0;

    // Local sign-in, the caller's own routes, and sign-out.
    const signIn = await inject('POST', '/api/v1/auth/local/sign-in', {
      payload: { email: 'admin@example.com', password: PASSWORD, device: { name: 'Mac' } },
    });
    expect(signIn.statusCode).toBe(201);
    const auth = { authorization: `Bearer ${signIn.json<{ token: string }>().token}` };
    expect((await inject('GET', '/api/v1/me', { headers: auth })).statusCode).toBe(200);
    const devices = await inject('GET', '/api/v1/me/devices', { headers: auth });
    expect(devices.statusCode).toBe(200);
    expect(
      (
        await inject('POST', '/api/v1/me/password', {
          headers: auth,
          payload: { currentPassword: PASSWORD, newPassword: `${PASSWORD}!` },
        })
      ).statusCode,
    ).toBe(204);
    expect((await inject('DELETE', `/api/v1/me/devices/${admin.tokenId}`, { headers: auth })).statusCode).toBe(404);

    // Invitations, accepted by the local path, and the users an admin manages.
    const invited = await inject('POST', '/api/v1/invitations', {
      headers: auth,
      payload: { email: 'bea@example.com' },
    });
    expect(invited.statusCode).toBe(201);
    const secret = invited.json<{ url: string }>().url.split('/invite/')[1]!;
    expect((await inject('GET', '/api/v1/invitations', { headers: auth })).statusCode).toBe(200);
    expect((await inject('GET', `/api/v1/invitations/lookup?secret=${secret}`)).statusCode).toBe(200);
    expect((await inject('GET', `/invite/${secret}`)).statusCode).toBe(200);
    const accepted = await inject('POST', '/api/v1/invitations/accept', {
      payload: { secret, password: PASSWORD, displayName: 'Bea', device: { name: 'Mac' } },
    });
    expect(accepted.statusCode).toBe(201);
    const bea = accepted.json<{ user: { id: string } }>().user.id;
    const other = await inject('POST', '/api/v1/invitations', { headers: auth, payload: { email: 'cy@example.com' } });
    const otherId = other.json<{ id: string }>().id;
    expect((await inject('DELETE', `/api/v1/invitations/${otherId}`, { headers: auth })).statusCode).toBe(204);
    expect((await inject('GET', '/api/v1/users', { headers: auth })).statusCode).toBe(200);
    const patched = await inject('PATCH', `/api/v1/users/${bea}`, { headers: auth, payload: { disabled: true } });
    expect(patched.statusCode).toBe(200);
    expect((await inject('POST', `/api/v1/users/${bea}/password-reset`, { headers: auth })).statusCode).toBe(201);

    // The desktop's OIDC flow, start to complete, for an invited address.
    await createInvitation(
      { ctx: h.ctx, settings: identitySettings(h.ctx.config), now: () => h.clock.now },
      h.tdb.scope,
      { email: 'dee@example.com', serverAdmin: false, createdBy: null, source: SYSTEM_SOURCE, serverUrl: PUBLIC_URL },
    );
    idp.nextUser({ sub: 'sub-dee', email: 'dee@example.com', email_verified: true, name: 'Dee' });
    const started = await inject('POST', '/api/v1/auth/oidc/start', {
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: 49152 },
    });
    expect(started.statusCode).toBe(201);
    const { flowId, authorizationUrl } = started.json<{ flowId: string; authorizationUrl: string }>();
    const back = await idp.authorize(authorizationUrl);
    const callback = await inject('GET', `${back.pathname}${back.search}`);
    const grant = new URL(String(callback.headers['location'])).searchParams.get('grant')!;
    const completed = await inject('POST', '/api/v1/auth/oidc/complete', {
      payload: { flowId, grant, codeVerifier: VERIFIER },
    });
    expect(completed.statusCode).toBe(201);

    // The browser's form sign-in and sign-out, which reach the session cookie and the browser flows.
    const form = await inject('POST', '/sign-in/local', {
      headers: { origin: PUBLIC_URL, 'content-type': 'application/x-www-form-urlencoded' },
      payload: new URLSearchParams({ email: 'admin@example.com', password: `${PASSWORD}!` }).toString(),
    });
    expect(form.statusCode).toBe(303);
    const cookie = String(form.headers['set-cookie']).split(';')[0]!;
    expect((await inject('GET', '/api/v1/me', { headers: { cookie } })).statusCode).toBe(200);
    expect((await inject('GET', '/sign-in/oidc')).statusCode).toBe(302);
    const out = await inject('POST', '/sign-out', {
      headers: { origin: PUBLIC_URL, cookie, 'content-type': 'application/x-www-form-urlencoded' },
      payload: '',
    });
    expect(out.statusCode).toBe(303);
    expect((await inject('POST', '/api/v1/auth/sign-out', { headers: auth })).statusCode).toBe(204);

    expectAllScoped(h.statements, tenantId);
    expectNoRawStatementsOn(h.ctx, IDENTITY_TABLES);
  });

  it('finds a token by its hash within the request’s tenant, in a unit', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    h.statements.entries.length = 0;
    expect((await inject('GET', '/api/v1/me', { headers: alice.headers })).statusCode).toBe(200);
    const lookup = h.statements.entries.find((entry) => entry.text.includes('from device_tokens t join users u'));
    expect(lookup?.tenantId).toBe(h.tdb.scope.tenantId);
    expectAllScoped(h.statements, h.tdb.scope.tenantId);
  });

  it('sweeps through the job loop: one unit per tenant, each deleting what expired', async () => {
    const second = await new TenantAdmin(h.db, directoryOf(h.ctx.tenancy)).create({ slug: 'second', name: 'Second' });
    const settings = identitySettings(h.ctx.config);
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const { hash } = mintToken();
    await repo.insertToken(h.tdb, {
      id: newId(),
      userId: alice.user.id,
      tokenHash: hash,
      deviceName: 'old',
      at: h.clock.now,
    });
    h.clock.advance(31 * DAY);
    const loop = vi.spyOn(h.ctx.tenancy, 'forEachTenant');
    h.statements.entries.length = 0;
    await sweepExpired({ ctx: h.ctx, settings, now: () => h.clock.now });
    expect(loop).toHaveBeenCalledWith(SWEEP_JOB, expect.any(Function), h.ctx.log);
    const deletesIn = (tenantId: string) =>
      h.statements.entries
        .filter((entry) => entry.tenantId === tenantId && entry.kind === 'statement')
        .map((e) => e.text);
    for (const tenantId of [h.tdb.scope.tenantId, second.scope.tenantId]) {
      expect(deletesIn(tenantId)).toEqual([
        expect.stringContaining('delete from device_tokens'),
        expect.stringContaining('delete from oidc_flows'),
        expect.stringContaining('delete from browser_flows'),
      ]);
    }
    expect(await repo.tokensOfUser(h.tdb, alice.user.id)).toEqual([]);
    expectAllScoped(
      { ...h.statements, entries: h.statements.entries.filter((e) => e.tenantId === h.tdb.scope.tenantId) },
      h.tdb.scope.tenantId,
    );
  });
});
