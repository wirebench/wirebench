import { afterEach, beforeEach, expect, it } from 'vitest';
import { PENDING_TOTP_MS, sweepExpired } from '../../../src/identity/sessions.js';
import { mintSecret, newId } from '../../../src/identity/tokens.js';
import * as tf from '../../../src/identity/two-factor/repo.js';
import { identitySettings } from '../../../src/identity/env.js';
import { describeDb } from '../../helpers/database.js';
import { identityHarness, signedInUser, type IdentityHarness } from '../../helpers/identity.js';

const MINUTE = 60_000;

describeDb('two-step sign-in repo (spec §7)', () => {
  let h: IdentityHarness;
  beforeEach(async () => {
    h = await identityHarness();
  });
  afterEach(() => h.close());

  const challenge = async (userId: string, expiresInMs = 5 * MINUTE) => {
    const id = newId();
    await tf.insertChallenge(h.tdb, {
      id,
      userId,
      secretHash: mintSecret().hash,
      purpose: 'sign-in',
      deviceName: 'laptop',
      tokenKind: 'device',
      at: h.clock.now,
      expiresAt: new Date(h.clock.now.getTime() + expiresInMs),
    });
    return id;
  };

  it('a recovery code and a challenge are taken once under two racing takes', async () => {
    const { user } = await signedInUser(h, { email: 'alice@example.com' });
    await tf.replaceRecoveryCodes(h.tdb, user.id, ['a', 'b'], h.clock.now);
    const uses = await Promise.all([
      tf.useRecoveryCode(h.tdb, user.id, 'a', h.clock.now),
      tf.useRecoveryCode(h.tdb, user.id, 'a', h.clock.now),
    ]);
    expect(uses.filter(Boolean)).toHaveLength(1);
    expect(await tf.recoveryCodesLeft(h.tdb, user.id)).toBe(1);
    await tf.replaceRecoveryCodes(h.tdb, user.id, ['c', 'd', 'e'], h.clock.now);
    expect(await tf.useRecoveryCode(h.tdb, user.id, 'b', h.clock.now)).toBe(false);
    expect(await tf.recoveryCodesLeft(h.tdb, user.id)).toBe(3);

    const id = await challenge(user.id);
    const takes = await Promise.all([tf.takeChallenge(h.tdb, id), tf.takeChallenge(h.tdb, id)]);
    expect(takes.filter(Boolean)).toHaveLength(1);
  });

  it('setTotpLastStep refuses a step at or below the stored one', async () => {
    const { user } = await signedInUser(h, { email: 'alice@example.com' });
    expect(await tf.upsertPendingTotp(h.tdb, user.id, Buffer.from('sealed'), h.clock.now)).toBe(true);
    expect(await tf.setTotpLastStep(h.tdb, user.id, 5)).toBe(false); // not confirmed yet
    expect(await tf.confirmTotp(h.tdb, user.id, 100, h.clock.now)).toBe(true);
    expect(await tf.upsertPendingTotp(h.tdb, user.id, Buffer.from('other'), h.clock.now)).toBe(false);
    expect(await tf.setTotpLastStep(h.tdb, user.id, 100)).toBe(false);
    expect(await tf.setTotpLastStep(h.tdb, user.id, 99)).toBe(false);
    expect(await tf.setTotpLastStep(h.tdb, user.id, 101)).toBe(true);
    expect((await tf.totpOf(h.tdb, user.id))?.lastStep).toBe(101);
    expect((await tf.totpOf(h.tdb, user.id))?.sealedSecret.toString()).toBe('sealed');
  });

  it('counts a challenge’s wrong attempts, starts one flow only, and does not find an expired one', async () => {
    const { user } = await signedInUser(h, { email: 'alice@example.com' });
    const id = await challenge(user.id);
    expect(await tf.bumpChallengeAttempts(h.tdb, id)).toBe(1);
    expect(await tf.bumpChallengeAttempts(h.tdb, id)).toBe(2);
    const flow = { flowId: newId(), codeChallenge: 'c', loopbackPort: 4000 };
    expect(await tf.startChallengeFlow(h.tdb, id, flow)).toBe(true);
    expect(await tf.startChallengeFlow(h.tdb, id, { ...flow, flowId: newId() })).toBe(false);
    expect((await tf.challengeByFlow(h.tdb, flow.flowId, h.clock.now))?.id).toBe(id);
    expect(await tf.challengeById(h.tdb, id, new Date(h.clock.now.getTime() + 6 * MINUTE))).toBeUndefined();
  });

  it('records a passkey use only against the counter it was read with', async () => {
    const { user } = await signedInUser(h, { email: 'alice@example.com' });
    const id = newId();
    const credentialId = Buffer.from('credential');
    await tf.insertPasskey(h.tdb, {
      id,
      userId: user.id,
      credentialId,
      publicKey: Buffer.from('key'),
      counter: 3,
      transports: ['internal'],
      name: 'Laptop',
      at: h.clock.now,
    });
    const found = await tf.passkeyByCredentialId(h.tdb, credentialId);
    expect(found).toMatchObject({ id, counter: 3, transports: ['internal'], name: 'Laptop', lastUsedAt: null });
    expect(await tf.usePasskey(h.tdb, id, 3, 4, h.clock.now)).toBe(true);
    expect(await tf.usePasskey(h.tdb, id, 3, 5, h.clock.now)).toBe(false);
    expect(await tf.twoFactorUsers(h.tdb, [user.id, 'nobody'])).toEqual(new Set([user.id]));
  });

  it('the sweep deletes expired challenges and stale pending secrets, and keeps the rest', async () => {
    const alice = (await signedInUser(h, { email: 'alice@example.com' })).user;
    const bob = (await signedInUser(h, { email: 'bob@example.com' })).user;
    const stale = await challenge(alice.id, MINUTE);
    const live = await challenge(alice.id, 60 * MINUTE);
    await tf.upsertPendingTotp(h.tdb, alice.id, Buffer.from('pending'), h.clock.now);
    await tf.upsertPendingTotp(h.tdb, bob.id, Buffer.from('confirmed'), h.clock.now);
    await tf.confirmTotp(h.tdb, bob.id, 1, h.clock.now);
    h.clock.advance(PENDING_TOTP_MS + MINUTE);
    await sweepExpired({ ctx: h.ctx, settings: identitySettings(h.ctx.config), now: () => h.clock.now });
    expect(await tf.challengeById(h.tdb, stale, new Date(0))).toBeUndefined();
    expect(await tf.challengeById(h.tdb, live, new Date(0))).toBeDefined();
    expect(await tf.totpOf(h.tdb, alice.id)).toBeUndefined();
    expect(await tf.totpOf(h.tdb, bob.id)).toBeDefined();
  });

  it('deleting a user deletes their methods', async () => {
    const { user } = await signedInUser(h, { email: 'alice@example.com' });
    await tf.upsertPendingTotp(h.tdb, user.id, Buffer.from('s'), h.clock.now);
    await tf.replaceRecoveryCodes(h.tdb, user.id, ['a'], h.clock.now);
    await challenge(user.id);
    await h.tdb.query('delete from users where id = $1', [user.id]);
    expect(await tf.totpOf(h.tdb, user.id)).toBeUndefined();
    expect(await tf.recoveryCodesLeft(h.tdb, user.id)).toBe(0);
  });
});
