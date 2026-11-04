/**
 * Slice 5 Task 12 (hosted edition spec §20.6): the relay token binds the tenant, the share, the viewer's user and
 * token ids, the target holder and an expiry 30 s ahead; any other token is refused.
 */
import { createHmac, hkdfSync, randomBytes } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  RELAY_TOKEN_TTL_MS,
  relayKey,
  SeenRelayTokens,
  signRelayToken,
  verifyRelayToken,
  type RelayClaimsInput,
} from '../../../src/operations/relay-token.js';

const secretsKey = randomBytes(32);
const key = relayKey(secretsKey);
const NOW = Date.parse('2026-11-04T12:00:00.000Z');

const claims: RelayClaimsInput = {
  tenantId: '00000000-0000-4000-8000-0000000000a1',
  shareId: 'abcdefghijklmnopqrstuvwxyz',
  workspaceId: 'ws-1',
  userId: 'user-1',
  tokenId: 'token-1',
  holder: '00000000-0000-4000-8000-0000000000b1',
  purpose: 'join',
  viewer: {
    name: 'Ben',
    tokenExpiresAt: NOW + 3_600_000,
    source: { actor: { kind: 'user', userId: 'user-1', email: 'ben@example.com', tokenId: 'token-1' } },
  },
};
const expect_ = { holder: claims.holder, shareId: claims.shareId, purpose: 'join' } as const;
const JTI = 'AAAAAAAAAAAAAAAAAAAAAA';

/** A token over `payload` with a valid signature under `under`: what a forger with the key could make. */
function forge(payload: unknown, under: Buffer = key): string {
  const body = Buffer.from(JSON.stringify(payload)).toString('base64url');
  return `${body}.${createHmac('sha256', under).update(body).digest('base64url')}`;
}

describe('the relay token (spec §20.6)', () => {
  it('derives its key with HKDF-SHA-256 and the relay info, not the secrets key itself', () => {
    expect(
      key.equals(Buffer.from(hkdfSync('sha256', secretsKey, Buffer.alloc(0), 'wirebench/instance-relay/v1', 32))),
    ).toBe(true);
    expect(key.equals(secretsKey)).toBe(false);
  });

  it('round-trips, with an expiry 30 s ahead', () => {
    const token = signRelayToken(key, claims, NOW);
    const found = verifyRelayToken(key, token, expect_, NOW);
    expect(found?.jti).toMatch(/^[A-Za-z0-9_-]{22}$/);
    expect(found).toEqual({ ...claims, jti: found?.jti, expiresAt: NOW + RELAY_TOKEN_TTL_MS });
    // Each token has its own random id.
    expect(verifyRelayToken(key, signRelayToken(key, claims, NOW), expect_, NOW)?.jti).not.toBe(found?.jti);
    expect(RELAY_TOKEN_TTL_MS).toBe(30_000);
  });

  it('is refused once expired', () => {
    const token = signRelayToken(key, claims, NOW);
    expect(verifyRelayToken(key, token, expect_, NOW + RELAY_TOKEN_TTL_MS - 1)).toBeDefined();
    expect(verifyRelayToken(key, token, expect_, NOW + RELAY_TOKEN_TTL_MS)).toBeUndefined();
  });

  it('is refused for another holder or another share', () => {
    const token = signRelayToken(key, claims, NOW);
    expect(verifyRelayToken(key, token, { ...expect_, holder: randomBytes(16).toString('hex') }, NOW)).toBeUndefined();
    expect(verifyRelayToken(key, token, { ...expect_, shareId: 'zzzzzzzzzzzzzzzzzzzzzzzzzz' }, NOW)).toBeUndefined();
  });

  it('is refused on the route it was not made for (review: purpose)', () => {
    const join = signRelayToken(key, claims, NOW);
    const info = signRelayToken(key, { ...claims, purpose: 'info' }, NOW);
    expect(verifyRelayToken(key, join, { ...expect_, purpose: 'info' }, NOW)).toBeUndefined();
    expect(verifyRelayToken(key, info, expect_, NOW)).toBeUndefined();
    expect(verifyRelayToken(key, info, { ...expect_, purpose: 'info' }, NOW)?.purpose).toBe('info');
  });

  it('is accepted once: the holder remembers each token id until its token expires (review: replay)', () => {
    const seen = new SeenRelayTokens();
    expect(seen.admit('a'.repeat(22), NOW + 1_000, NOW)).toBe(true);
    expect(seen.admit('a'.repeat(22), NOW + 1_000, NOW + 500)).toBe(false);
    expect(seen.admit('b'.repeat(22), NOW + 30_000, NOW + 500)).toBe(true);
    // Past its expiry an id is forgotten: its token is refused as expired anyway.
    expect(seen.admit('c'.repeat(22), NOW + 31_000, NOW + 1_000)).toBe(true);
    expect(seen.size).toBe(2);
  });

  it('is refused under another secrets key', () => {
    const token = signRelayToken(relayKey(randomBytes(32)), claims, NOW);
    expect(verifyRelayToken(key, token, expect_, NOW)).toBeUndefined();
  });

  for (const field of [
    'tenantId',
    'shareId',
    'workspaceId',
    'userId',
    'tokenId',
    'holder',
    'purpose',
    'jti',
    'expiresAt',
  ] as const) {
    it(`is refused when ${field} was changed after signing`, () => {
      const token = signRelayToken(key, claims, NOW);
      const [body, mac] = token.split('.') as [string, string];
      const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as Record<string, unknown>;
      payload[field] = field === 'expiresAt' ? NOW + 3_600_000 : 'changed';
      const tampered = `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`;
      expect(
        verifyRelayToken(key, tampered, { holder: 'changed', shareId: 'changed', purpose: 'join' }, NOW),
      ).toBeUndefined();
      expect(verifyRelayToken(key, tampered, expect_, NOW)).toBeUndefined();
    });
  }

  it('is refused when the viewer identity was changed after signing', () => {
    const [body, mac] = signRelayToken(key, claims, NOW).split('.') as [string, string];
    const payload = JSON.parse(Buffer.from(body, 'base64url').toString('utf8')) as { viewer: { name: string } };
    payload.viewer.name = 'Mallory';
    expect(
      verifyRelayToken(key, `${Buffer.from(JSON.stringify(payload)).toString('base64url')}.${mac}`, expect_, NOW),
    ).toBeUndefined();
  });

  it('refuses a well-signed token that misses a field or has the wrong version', () => {
    const whole = { ...claims, jti: JTI, expiresAt: NOW + 1000, v: 1 };
    for (const field of ['tokenId', 'purpose', 'jti']) {
      const missing: Record<string, unknown> = { ...whole };
      delete missing[field];
      expect({ field, found: verifyRelayToken(key, forge(missing), expect_, NOW) }).toEqual({
        field,
        found: undefined,
      });
    }
    expect(verifyRelayToken(key, forge({ ...whole, purpose: 'admin' }), expect_, NOW)).toBeUndefined();
    expect(verifyRelayToken(key, forge({ ...whole, v: 2 }), expect_, NOW)).toBeUndefined();
    expect(verifyRelayToken(key, forge(whole), expect_, NOW)).toBeDefined();
  });

  it('refuses a token that lives longer than 30 s, even well signed', () => {
    const far = forge({ ...claims, jti: JTI, expiresAt: NOW + RELAY_TOKEN_TTL_MS + 1, v: 1 });
    expect(verifyRelayToken(key, far, expect_, NOW)).toBeUndefined();
  });

  for (const junk of ['', '.', 'abc', 'a.b.c', 'not base64.x', `${'a'.repeat(5000)}.x`]) {
    it(`refuses junk ${JSON.stringify(junk.slice(0, 12))}`, () => {
      expect(verifyRelayToken(key, junk, expect_, NOW)).toBeUndefined();
    });
  }
});
