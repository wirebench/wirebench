import { afterEach, beforeEach, expect, it } from 'vitest';
import * as repo from '../../../src/identity/repo.js';
import { mintSecret, newId } from '../../../src/identity/tokens.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

describeDb('identity repo', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  it('keys users on the lower-cased email and keeps the typed one for display', async () => {
    const user = await repo.insertUser(h.db, {
      id: newId(),
      email: 'Alice@Example.com',
      displayName: 'Alice',
      serverAdmin: false,
      at: h.clock.now,
    });
    expect(user).toMatchObject({ email: 'Alice@Example.com', emailLower: 'alice@example.com', disabledAt: null });
    expect(user.createdAt).toBe('2026-09-24T12:00:00.000Z');
    expect((await repo.findUserByEmail(h.db, 'alice@example.com'))?.id).toBe(user.id);
    await expect(
      repo.insertUser(h.db, {
        id: newId(),
        email: 'ALICE@example.com',
        displayName: 'A',
        serverAdmin: false,
        at: h.clock.now,
      }),
    ).rejects.toThrow();
  });

  it('allows one open invite per email, and a second once the first is revoked or accepted', async () => {
    const invite = (secretHash: string) =>
      repo.insertInvitation(h.db, {
        id: newId(),
        kind: 'invite',
        email: 'bob@example.com',
        userId: null,
        secretHash,
        serverAdmin: false,
        createdBy: null,
        createdAt: h.clock.now,
        expiresAt: new Date(h.clock.now.getTime() + 1000),
      });
    const first = await invite(mintSecret().hash);
    await expect(invite(mintSecret().hash)).rejects.toThrow();
    await repo.revokeInvitation(h.db, first.id, h.clock.now);
    const second = await invite(mintSecret().hash);
    expect((await repo.openInvitationByEmail(h.db, 'bob@example.com', h.clock.now))?.id).toBe(second.id);
    expect(
      await repo.openInvitationByEmail(h.db, 'bob@example.com', new Date(h.clock.now.getTime() + 2000)),
    ).toBeUndefined();
  });

  it('joins a token to its user, revokes all but one device, and sweeps the expired', async () => {
    const alice = await signedInUser(h, { email: 'alice@example.com' });
    const second = await signedInUser(h, { email: 'carol@example.com' });
    const { hash } = { hash: (await repo.tokensOfUser(h.db, alice.user.id))[0]!.tokenHash };
    expect((await repo.tokenByHash(h.db, hash))?.user.email).toBe('alice@example.com');
    await repo.insertToken(h.db, {
      id: newId(),
      userId: alice.user.id,
      tokenHash: mintSecret().hash,
      deviceName: 'phone',
      at: h.clock.now,
    });
    await repo.revokeTokensOfUser(h.db, alice.user.id, h.clock.now, alice.tokenId);
    expect((await repo.tokensOfUser(h.db, alice.user.id)).map((t) => t.id)).toEqual([alice.tokenId]);
    expect(await repo.tokensOfUser(h.db, second.user.id)).toHaveLength(1);
    const later = new Date(h.clock.now.getTime() + 10_000);
    expect(
      await repo.deleteExpiredTokens(h.db, {
        idleBefore: later,
        createdBefore: new Date(0),
        revokedBefore: new Date(0),
      }),
    ).toBe(3);
  });

  it('reports sign-in methods per user, including none', async () => {
    const local = await signedInUser(h, { email: 'a@example.com', password: 'p'.repeat(12) });
    const none = await signedInUser(h, { email: 'b@example.com' });
    await repo.insertOidcIdentity(h.db, {
      issuer: 'https://idp.test',
      subject: 'sub-1',
      userId: none.user.id,
      at: h.clock.now,
    });
    const methods = await repo.signInMethodsOf(h.db, [local.user.id, none.user.id]);
    expect(methods.get(local.user.id)).toEqual({ local: true, oidc: [] });
    expect(methods.get(none.user.id)).toEqual({ local: false, oidc: [{ issuer: 'https://idp.test' }] });
    expect((await repo.signInMethodsOf(h.db, [])).size).toBe(0);
  });
});
