/**
 * Identity with two tenants under the forced policy (tenancy Task 18; plan Task 8 review M4). Every lookup by a
 * secret or a hash resolved across tenants until `0021`; here each one of A's, sent on B's host, answers `401` or
 * `404`, and the same email, flow id or token row lives in both tenants as two.
 */
import { afterAll, beforeAll, expect, it } from 'vitest';
import { identitySettings } from '../../../../src/identity/env.js';
import * as repo from '../../../../src/identity/repo.js';
import { sweepExpired } from '../../../../src/identity/sessions.js';
import { hashSecret, mintSecret, mintToken, newId } from '../../../../src/identity/tokens.js';
import { describeDb } from '../../../helpers/database.js';
import { countIn, twoTenants, type Tenant, type TwoTenants } from './two-tenants.js';

const PASSWORD = 'correct horse battery';
const DAY = 86_400_000;
const BROWSER_ENV = {
  WIREBENCH_SERVER_BROWSER_CLIENT: 'true',
  WIREBENCH_SERVER_SECRETS_KEY: Buffer.alloc(32, 7).toString('base64'),
};

describeDb('identity in two tenants (tenancy Task 18)', () => {
  let t: TwoTenants;
  beforeAll(async () => {
    t = await twoTenants({ env: BROWSER_ENV });
  });
  afterAll(() => t.close());

  const invite = async (tenant: Tenant, email: string): Promise<string> => {
    const admin = await tenant.user({ email: `admin-${newId()}@example.com`, serverAdmin: true });
    const res = await tenant.call<{ url: string }>(admin, 'POST', '/invitations', { email });
    expect(res.status).toBe(201);
    expect(res.body.url.startsWith(`${tenant.origin}/invite/`)).toBe(true);
    return res.body.url.split('/invite/')[1]!;
  };
  const accept = (tenant: Tenant, secret: string) =>
    tenant.call<{ token: string; user: { id: string } }>(undefined, 'POST', '/invitations/accept', {
      secret,
      displayName: 'Bob',
      password: PASSWORD,
      device: { name: 'Mac' },
    });

  it('the same email signs up in both tenants as two users, each signed in on its own host only', async () => {
    const inA = await accept(t.a, await invite(t.a, 'bob@example.com'));
    const inB = await accept(t.b, await invite(t.b, 'Bob@example.com'));
    expect(inA.status).toBe(201);
    expect(inB.status).toBe(201);
    expect(inA.body.user.id).not.toBe(inB.body.user.id);
    expect((await repo.findUserByEmail(t.a.tdb, 'bob@example.com'))?.id).toBe(inA.body.user.id);
    expect((await repo.findUserByEmail(t.b.tdb, 'bob@example.com'))?.id).toBe(inB.body.user.id);
    // Each password signs in on its own host; A's account is no one on B's.
    const signIn = (tenant: Tenant) =>
      tenant.call(undefined, 'POST', '/auth/local/sign-in', {
        email: 'bob@example.com',
        password: PASSWORD,
        device: { name: 'Mac' },
      });
    expect((await signIn(t.a)).status).toBe(201);
    expect((await signIn(t.b)).status).toBe(201);
    const me = (tenant: Tenant, token: string) =>
      tenant.inject({ method: 'GET', url: '/api/v1/me', headers: { authorization: `Bearer ${token}` } });
    expect((await me(t.a, inA.body.token)).json<{ user: { id: string } }>().user.id).toBe(inA.body.user.id);
    expect((await me(t.b, inA.body.token)).statusCode).toBe(401);
    expect((await me(t.a, inB.body.token)).statusCode).toBe(401);
  });

  it("A's bearer token and A's cookie session are 401 on B's host", async () => {
    const alice = await t.a.user({ email: 'alice@example.com' });
    expect((await t.a.call(alice, 'GET', '/me')).status).toBe(200);
    expect((await t.b.call(alice, 'GET', '/me')).status).toBe(401);
    const session = await t.a.user({ email: 'alice-browser@example.com', kind: 'browser' });
    const cookie = { cookie: `__Host-wb_session=${session.token}` };
    expect((await t.a.inject({ method: 'GET', url: '/api/v1/me', headers: cookie })).statusCode).toBe(200);
    expect((await t.b.inject({ method: 'GET', url: '/api/v1/me', headers: cookie })).statusCode).toBe(401);
    // B's refusals spent nothing of A's: the token row is still there, unrevoked.
    expect((await repo.tokensOfUser(t.a.tdb, session.user.id)).map((row) => row.revokedAt)).toEqual([null]);
  });

  it("A's invitation secret is unknown on B: the lookup, the page and the accept", async () => {
    const secret = await invite(t.a, 'carol@example.com');
    const lookup = (tenant: Tenant) =>
      tenant.inject({ method: 'GET', url: `/api/v1/invitations/lookup?secret=${secret}` });
    expect((await lookup(t.b)).statusCode).toBe(404);
    const page = (tenant: Tenant) => tenant.inject({ method: 'GET', url: `/invite/${secret}` });
    const onB = await page(t.b);
    expect(onB.body).toContain('This invitation has expired or was already used.');
    expect(onB.body).not.toContain('carol@example.com');
    expect((await accept(t.b, secret)).status).toBe(404);
    expect(await repo.findUserByEmail(t.b.tdb, 'carol@example.com')).toBeUndefined();
    // Still open in A, and spent there.
    expect((await lookup(t.a)).statusCode).toBe(200);
    expect((await page(t.a)).body).toContain('carol@example.com');
    expect((await accept(t.a, secret)).status).toBe(201);
  });

  it("A's limiter does not slow B", async () => {
    await t.a.user({ email: 'dave@example.com', password: PASSWORD });
    await t.b.user({ email: 'dave@example.com', password: PASSWORD });
    const wrong = (tenant: Tenant) =>
      tenant.call(undefined, 'POST', '/auth/local/sign-in', {
        email: 'dave@example.com',
        password: 'not the password',
        device: { name: 'Mac' },
      });
    let limited = false;
    for (let attempt = 0; attempt < 100 && !limited; attempt++) limited = (await wrong(t.a)).status === 429;
    expect(limited, 'A is rate limited').toBe(true);
    // The same address and the same email on B: B's buckets are its own.
    expect((await wrong(t.b)).status).toBe(401);
    const right = await t.b.call(undefined, 'POST', '/auth/local/sign-in', {
      email: 'dave@example.com',
      password: PASSWORD,
      device: { name: 'Mac' },
    });
    expect(right.status).toBe(201);
  });

  it('A’s OIDC flow id, state and grant complete nothing on B (repository level; OIDC is 404 hosted)', async () => {
    // Flow ids are minted (spec §19.3 rule 2), so each tenant has its own; B's is there to be left alone.
    const id = newId();
    const other = newId();
    const grant = mintSecret();
    for (const [tenant, flowId] of [
      [t.a, id],
      [t.b, other],
    ] as const) {
      await repo.insertFlow(tenant.tdb, {
        id: flowId,
        codeChallenge: 'c'.repeat(43),
        loopbackPort: 49152,
        deviceName: 'Mac',
        state: `state-${tenant.slug}`,
        nonce: 'nonce',
        createdAt: t.h.clock.now,
        expiresAt: new Date(t.h.clock.now.getTime() + 600_000),
      });
    }
    const user = await t.a.user({ email: 'erin@example.com' });
    await repo.grantFlow(t.a.tdb, id, grant.hash, user.user.id);
    expect(await repo.flowByState(t.b.tdb, 'state-acme')).toBeUndefined();
    expect(await repo.flowById(t.b.tdb, id)).toBeUndefined();
    expect(await repo.claimGrantedFlow(t.b.tdb, id, grant.hash)).toBe(false);
    await repo.deleteFlow(t.b.tdb, id);
    expect(await repo.claimGrantedFlow(t.a.tdb, id, grant.hash)).toBe(true);
    expect(await repo.flowById(t.b.tdb, other)).toBeDefined();
  });

  it('a browser flow’s state of A’s is claimed by nothing on B (repository level)', async () => {
    const state = mintSecret();
    const insert = (tenant: Tenant) =>
      tenant.tdb.query(
        `insert into browser_flows (id, provider, state_hash, redirect_to, expires_at, created_at)
         values ($1, 'oidc', $2, '/', $3, $4)`,
        [newId(), state.hash, new Date(t.h.clock.now.getTime() + 600_000), t.h.clock.now],
      );
    await insert(t.a);
    // The statement `takeBrowserFlow` claims with.
    const claim = (tenant: Tenant) =>
      tenant.tdb.query(`delete from browser_flows where state_hash = $1 and provider = 'oidc' returning id`, [
        hashSecret(state.secret),
      ]);
    expect((await claim(t.b)).rowCount).toBe(0);
    expect((await claim(t.a)).rowCount).toBe(1);
  });

  it('the sweep expires rows in both tenants', async () => {
    const stale = async (tenant: Tenant) => {
      const user = await tenant.user({ email: `sweep-${tenant.slug}@example.com` });
      const { hash } = mintToken();
      await repo.insertToken(tenant.tdb, {
        id: newId(),
        userId: user.user.id,
        tokenHash: hash,
        deviceName: 'old',
        at: t.h.clock.now,
      });
      return user.user.id;
    };
    const inA = await stale(t.a);
    const inB = await stale(t.b);
    const fresh = await t.b.user({ email: 'fresh@example.com' });
    t.h.clock.advance(31 * DAY);
    await repo.touchToken(t.b.tdb, fresh.tokenId, t.h.clock.now);
    await sweepExpired({ ctx: t.h.ctx, settings: identitySettings(t.h.ctx.config), now: () => t.h.clock.now });
    expect(await repo.tokensOfUser(t.a.tdb, inA)).toEqual([]);
    expect(await repo.tokensOfUser(t.b.tdb, inB)).toEqual([]);
    expect(await countIn(t.b, 'device_tokens', 'id = $1', [fresh.tokenId])).toBe(1);
  });
});
