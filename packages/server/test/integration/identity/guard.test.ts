import { afterEach, beforeEach, expect, it } from 'vitest';
import type { ServerModule } from '../../../src/context.js';
import { requireServerAdmin, requireUser } from '../../../src/identity/guard.js';
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
