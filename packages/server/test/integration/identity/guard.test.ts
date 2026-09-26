import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadConfig } from '../../../src/config.js';
import type { ServerModule } from '../../../src/context.js';
import { identitySettings } from '../../../src/identity/env.js';
import { callerForToken, requireServerAdmin, requireUser } from '../../../src/identity/guard.js';
import * as repo from '../../../src/identity/repo.js';
import { mintToken } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const DAY = 24 * 60 * 60 * 1000;

/** A module registered after identity, the way teams-access will be: it only reads request.caller. */
const probeModule: ServerModule = {
  name: 'teams-access',
  // eslint-disable-next-line @typescript-eslint/require-await -- ServerModule.register is async; this one has no await
  register: async (app) => {
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/probe/user', { preHandler: requireUser }, async (request) => ({ caller: request.caller }));
    // eslint-disable-next-line @typescript-eslint/require-await -- route handler has no await
    app.get('/probe/admin', { preHandler: requireServerAdmin }, async (request) => ({ id: request.caller?.id }));
  },
};

describeDb('the caller guard (§3.2)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness({ modules: [probeModule] });
  });
  afterEach(() => h.close());

  const get = (url: string, authorization?: string) =>
    h.app.inject({ method: 'GET', url, ...(authorization !== undefined ? { headers: { authorization } } : {}) });

  it('answers 401 identity-unauthenticated without a header, with garbage, and with an unknown token', async () => {
    for (const header of [undefined, 'Basic abc', `Bearer ${mintToken().token}`]) {
      const res = await get('/api/v1/probe/user', header);
      expect(res.statusCode).toBe(401);
      expect(res.json()).toEqual({ code: 'identity-unauthenticated', message: 'Sign in to continue.' });
    }
  });

  it('sets request.caller for a later module from a valid token, and gates admin routes', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const ok = await get('/api/v1/probe/user', alice.headers.authorization);
    expect(ok.statusCode).toBe(200);
    expect(ok.json()).toEqual({
      caller: { id: alice.user.id, email: 'alice@example.com', serverAdmin: false, tokenId: alice.tokenId },
    });
    const forbidden = await get('/api/v1/probe/admin', alice.headers.authorization);
    expect(forbidden.statusCode).toBe(403);
    expect(forbidden.json<{ code: string }>().code).toBe('identity-forbidden');
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    expect((await get('/api/v1/probe/admin', root.headers.authorization)).statusCode).toBe(200);
  });

  it('answers 403 identity-user-disabled for a valid token of a disabled user', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', disabled: true });
    const res = await get('/api/v1/probe/user', alice.headers.authorization);
    expect(res.statusCode).toBe(403);
    expect(res.json<{ code: string }>().code).toBe('identity-user-disabled');
  });

  it('expires a token idle for 30 days or older than 180, deleting the row lazily', async () => {
    const idle = await signedInUser(h, { email: 'idle@example.com' });
    h.clock.advance(31 * DAY);
    expect((await get('/api/v1/probe/user', idle.headers.authorization)).statusCode).toBe(401);
    expect(await repo.tokensOfUser(h.db, idle.user.id)).toHaveLength(0);

    const old = await signedInUser(h, { email: 'old@example.com' });
    for (let day = 0; day < 181; day += 1) {
      h.clock.advance(DAY); // used daily, so never idle
      const res = await get('/api/v1/probe/user', old.headers.authorization);
      if (day < 180) expect(res.statusCode).toBe(200);
      else expect(res.statusCode).toBe(401);
    }
  });

  it('writes lastUsedAt at most once a minute', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const before = (await repo.tokensOfUser(h.db, alice.user.id))[0]!.lastUsedAt;
    h.clock.advance(30_000);
    await get('/api/v1/probe/user', alice.headers.authorization);
    expect((await repo.tokensOfUser(h.db, alice.user.id))[0]!.lastUsedAt).toBe(before);
    h.clock.advance(31_000);
    await get('/api/v1/probe/user', alice.headers.authorization);
    expect((await repo.tokensOfUser(h.db, alice.user.id))[0]!.lastUsedAt).toBe(h.clock.now.toISOString());
  });
});

describeDb('callerForToken (live-updates §3.3, §5.1)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  /** The harness server's own defaults: a token expires after 30 idle days or at 180 days old. */
  const settings = identitySettings(
    loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: process.cwd(),
        WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      },
      '0.0.0-test',
    ),
  );
  const resolve = (token: string) => callerForToken({ db: h.db, settings, now: () => h.clock.now }, token);
  const UNAUTHENTICATED = { code: 'identity-unauthenticated', details: { status: 401 } };

  it('answers the caller, the display name and the token’s creation time for a valid token', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const root = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    h.clock.advance(5 * 60_000); // the creation time, not the time of the check
    expect(await resolve(alice.token)).toEqual({
      caller: { id: alice.user.id, email: 'alice@example.com', serverAdmin: false, tokenId: alice.tokenId },
      displayName: 'alice',
      tokenCreatedAt: '2026-09-24T12:00:00.000Z',
    });
    expect((await resolve(root.token)).caller).toMatchObject({ serverAdmin: true, tokenId: root.tokenId });
  });

  it('refuses a malformed, an unknown and a revoked token with identity-unauthenticated', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    await repo.revokeToken(h.db, alice.tokenId, h.clock.now);
    for (const token of ['not-a-token', mintToken().token, alice.token]) {
      await expect(resolve(token)).rejects.toMatchObject(UNAUTHENTICATED);
    }
  });

  it('refuses an idle or an over-age token and deletes its row lazily', async () => {
    const idle = await signedInUser(h, { email: 'idle@example.com' });
    const old = await signedInUser(h, { email: 'old@example.com' });
    h.clock.advance(31 * DAY);
    await expect(resolve(idle.token)).rejects.toMatchObject(UNAUTHENTICATED);
    expect(await repo.tokensOfUser(h.db, idle.user.id)).toEqual([]);

    h.clock.advance(150 * DAY); // 181 days since creation
    await repo.touchToken(h.db, old.tokenId, h.clock.now); // used just now, so only its age can expire it
    await expect(resolve(old.token)).rejects.toMatchObject(UNAUTHENTICATED);
    expect(await repo.tokensOfUser(h.db, old.user.id)).toEqual([]);
  });

  it('refuses a live token of a disabled user with identity-user-disabled and keeps the row', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com', disabled: true });
    await expect(resolve(alice.token)).rejects.toMatchObject({
      code: 'identity-user-disabled',
      details: { status: 403 },
    });
    expect(await repo.tokensOfUser(h.db, alice.user.id)).toHaveLength(1);
  });

  it('writes lastUsedAt at most once a minute, as a request does', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const lastUsed = async () => (await repo.tokensOfUser(h.db, alice.user.id))[0]?.lastUsedAt;
    const created = await lastUsed();
    h.clock.advance(30_000);
    await resolve(alice.token);
    expect(await lastUsed()).toBe(created);
    h.clock.advance(31_000);
    await resolve(alice.token);
    expect(await lastUsed()).toBe(h.clock.now.toISOString());
  });
});
