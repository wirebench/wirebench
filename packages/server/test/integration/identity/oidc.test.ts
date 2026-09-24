import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { createInvitation } from '../../../src/identity/invitations.js';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret, pkceChallenge } from '../../../src/identity/tokens.js';
import { main } from '../../../src/main.js';
import { describeDb } from '../../helpers/database.js';
import { startFakeOidcIssuer, type FakeOidcIssuer } from '../../helpers/fake-oidc-issuer.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const VERIFIER = 'v'.repeat(43);
const PORT = 49152;

describeDb('OIDC sign-in (§3.1, §3.3, §13.3)', () => {
  let idp: FakeOidcIssuer;
  let h: IdentityHarness;
  beforeEach(async () => {
    idp = await startFakeOidcIssuer();
    h = await identityHarness({
      env: {
        WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
        WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
        WIREBENCH_SERVER_OIDC_DISPLAY_NAME: 'Example IdP',
        WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
      },
    });
  });
  afterEach(async () => {
    await h.close();
    await idp.close();
  });

  /** Injects env through the harness's module: `createInvitation` wants an IdentityEnv-shaped object. */
  const env = () =>
    ({
      ctx: { db: h.db, config: { publicUrl: 'https://wirebench.test' }, events: h.events },
      settings: { invitationMs: 7 * 86_400_000 },
      now: () => h.clock.now,
    }) as never;
  const start = () =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/start',
      payload: { device: { name: 'Mac' }, codeChallenge: pkceChallenge(VERIFIER), loopbackPort: PORT },
    });
  const callback = async (authorizationUrl: string) => {
    const back = await idp.authorize(authorizationUrl);
    return h.app.inject({ method: 'GET', url: `${back.pathname}${back.search}` });
  };
  const loopback = (res: { headers: Record<string, unknown> }) => new URL(String(res.headers['location']));
  const complete = (flowId: string, grant: string, codeVerifier = VERIFIER, ip = '10.0.0.1') =>
    h.app.inject({
      method: 'POST',
      url: '/api/v1/auth/oidc/complete',
      payload: { flowId, grant, codeVerifier },
      remoteAddress: ip,
    });

  /** The whole happy path up to the grant. */
  const signInUpToGrant = async () => {
    const started = await start();
    expect(started.statusCode).toBe(201);
    const { flowId, authorizationUrl } = started.json<{ flowId: string; authorizationUrl: string }>();
    expect(authorizationUrl.startsWith(`${idp.url}/authorize?`)).toBe(true);
    expect(new URL(authorizationUrl).searchParams.get('redirect_uri')).toBe(
      'https://wirebench.test/api/v1/auth/oidc/callback',
    );
    const cb = await callback(authorizationUrl);
    return { flowId, cb };
  };

  it('meta reports OIDC with its display name', async () => {
    expect((await h.app.inject({ method: 'GET', url: '/api/v1/meta' })).json()).toMatchObject({
      auth: { local: true, oidc: true, oidcDisplayName: 'Example IdP' },
    });
  });

  it('start → callback → complete creates an invited user with the invitation’s admin flag and links the identity', async () => {
    const accepted = vi.fn();
    h.events.on('invitation.accepted', accepted);
    const invitation = await createInvitation(env(), {
      email: 'Alice@example.com',
      serverAdmin: true,
      createdBy: null,
    });
    idp.nextUser({ sub: 'sub-alice', email: 'alice@EXAMPLE.com', email_verified: true, name: 'Alice Liddell' });
    const { flowId, cb } = await signInUpToGrant();
    expect(cb.statusCode).toBe(302);
    const back = loopback(cb);
    expect(back.origin).toBe(`http://127.0.0.1:${PORT}`);
    expect(back.pathname).toBe('/callback');
    expect(back.searchParams.get('flow')).toBe(flowId);
    const grant = back.searchParams.get('grant')!;
    const done = await complete(flowId, grant);
    expect(done.statusCode).toBe(201);
    const body = done.json<{ token: string; user: { id: string; displayName: string; serverAdmin: boolean } }>();
    expect(body.user).toMatchObject({ displayName: 'Alice Liddell', serverAdmin: true });
    expect(accepted).toHaveBeenCalledWith({ invitationId: invitation.id, userId: body.user.id });
    const me = await h.app.inject({
      method: 'GET',
      url: '/api/v1/me',
      headers: { authorization: `Bearer ${body.token}` },
    });
    expect(me.json()).toMatchObject({ methods: { local: false, oidc: [{ issuer: idp.url }] } });
    expect(await repo.flowById(h.db, flowId)).toBeUndefined(); // single use
    expect(idp.tokenRequests).toBe(1);
  });

  it('links an existing local user by verified email; a second sign-in matches the identity row without an email', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', password: 'p'.repeat(12) });
    idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true });
    const first = await signInUpToGrant();
    expect(
      (await complete(first.flowId, loopback(first.cb).searchParams.get('grant')!)).json<{ user: { id: string } }>()
        .user.id,
    ).toBe(alice.user.id);
    idp.nextUser({ sub: 'sub-alice' }); // no email claim at all this time
    const second = await signInUpToGrant();
    expect(
      (await complete(second.flowId, loopback(second.cb).searchParams.get('grant')!)).json<{ user: { id: string } }>()
        .user.id,
    ).toBe(alice.user.id);
  });

  it.each([
    [
      'an unverified email',
      { sub: 's1', email: 'bob@example.com', email_verified: false },
      'identity-email-unverified',
    ],
    ['no email_verified claim', { sub: 's2', email: 'bob@example.com' }, 'identity-email-unverified'],
    ['an uninvited email', { sub: 's3', email: 'nobody@example.com', email_verified: true }, 'identity-not-invited'],
  ])('refuses %s by redirecting the browser to the loopback with the code', async (_name, user, code) => {
    await createInvitation(env(), { email: 'bob@example.com', serverAdmin: false, createdBy: null }).catch(
      () => undefined,
    );
    idp.nextUser(user);
    const { flowId, cb } = await signInUpToGrant();
    expect(cb.statusCode).toBe(302);
    expect(loopback(cb).searchParams.get('error')).toBe(code);
    expect(await repo.flowById(h.db, flowId)).toBeUndefined();
    expect(await repo.findUserByEmail(h.db, 'nobody@example.com')).toBeUndefined();
  });

  it('refuses a disabled user whether matched by identity or by email', async () => {
    const bob = await signedInUser(h, { email: 'bob@example.com', disabled: true });
    idp.nextUser({ sub: 'sub-bob', email: 'bob@example.com', email_verified: true });
    expect(loopback((await signInUpToGrant()).cb).searchParams.get('error')).toBe('identity-user-disabled');
    await repo.insertOidcIdentity(h.db, { issuer: idp.url, subject: 'sub-bob', userId: bob.user.id, at: h.clock.now });
    expect(loopback((await signInUpToGrant()).cb).searchParams.get('error')).toBe('identity-user-disabled');
  });

  it('refuses a wrong state, a reused grant, a wrong verifier and an expired flow', async () => {
    await createInvitation(env(), { email: 'alice@example.com', serverAdmin: false, createdBy: null });
    const wrongState = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?code=x&state=${mintSecret().secret}`,
    });
    expect(wrongState.statusCode).toBe(400);
    expect(wrongState.headers['content-type']).toContain('text/html');
    expect(wrongState.body).toContain('Return to Wirebench');

    const { flowId, cb } = await signInUpToGrant();
    const grant = loopback(cb).searchParams.get('grant')!;
    expect((await complete(flowId, grant, 'w'.repeat(43))).json<{ code: string }>().code).toBe('identity-flow-invalid');
    expect((await complete(flowId, mintSecret().secret)).json<{ code: string }>().code).toBe('identity-flow-invalid');
    expect((await complete(flowId, grant)).statusCode).toBe(201);
    expect((await complete(flowId, grant)).json<{ code: string }>().code).toBe('identity-flow-invalid'); // reused

    idp.nextUser({ sub: 'sub-alice', email: 'alice@example.com', email_verified: true });
    const late = await start();
    const { flowId: lateId, authorizationUrl } = late.json<{ flowId: string; authorizationUrl: string }>();
    h.clock.advance(11 * 60_000);
    const expired = await callback(authorizationUrl);
    expect(expired.statusCode).toBe(400);
    expect(await repo.flowById(h.db, lateId)).toBeDefined(); // the sweep removes it; the callback only refuses
  });

  it('redirects the IdP’s refusal to the loopback as identity-oidc-refused', async () => {
    const { flowId } = (await start()).json<{ flowId: string }>();
    const flow = await repo.flowById(h.db, flowId);
    const res = await h.app.inject({
      method: 'GET',
      url: `/api/v1/auth/oidc/callback?error=access_denied&state=${flow!.state}`,
    });
    expect(res.statusCode).toBe(302);
    expect(loopback(res).searchParams.get('error')).toBe('identity-oidc-refused');
  });

  it('rate-limits complete per address', async () => {
    const { flowId } = (await start()).json<{ flowId: string }>();
    for (let i = 0; i < 10; i += 1) await complete(flowId, mintSecret().secret);
    expect((await complete(flowId, mintSecret().secret)).statusCode).toBe(429);
  });

  it('serve exits 2 naming the module when discovery fails', async () => {
    await idp.close();
    const dataDir = await mkTempDir();
    const stderr = { write: vi.fn() };
    const code = await main(
      ['serve'],
      {
        stdout: { write: vi.fn() },
        stderr,
        env: {
          WIREBENCH_SERVER_DATABASE_URL: h.db.url,
          WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
          WIREBENCH_SERVER_DATA_DIR: dataDir,
          WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
          WIREBENCH_SERVER_OIDC_ISSUER: idp.url,
          WIREBENCH_SERVER_OIDC_CLIENT_ID: idp.clientId,
          WIREBENCH_SERVER_OIDC_CLIENT_SECRET: idp.clientSecret,
          WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL: 'true',
        },
      },
      { exit: vi.fn() },
    );
    await removeTempDir(dataDir);
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((c) => String(c[0])).join('')).toContain('a module failed to register');
    idp = await startFakeOidcIssuer(); // so afterEach can close something
  });
});
