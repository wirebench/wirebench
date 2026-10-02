import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLicense } from '../../../src/licensing/format.js';
import { PRODUCTION_PUBLIC_KEYS } from '../../../src/licensing/keys.js';
import { license, PAYLOAD, signLicense, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const NOW = new Date('2026-09-24T12:00:00Z');

describe('verifyLicense (licensing spec §3.1, §3.2)', () => {
  it('round-trips a signed payload', () => {
    expect(verifyLicense(license(keys), [keys.publicKey], NOW)).toEqual({ ok: true, license: PAYLOAD });
  });

  it('accepts surrounding whitespace from a paste', () => {
    expect(verifyLicense(`  ${license(keys)}\n`, [keys.publicKey], NOW).ok).toBe(true);
  });

  it('tries every key, so a rotation can ship two', () => {
    expect(verifyLicense(license(keys), [other.publicKey, keys.publicKey], NOW).ok).toBe(true);
  });

  it('does not look at expiry: a license that expired yesterday verifies', () => {
    const expired = license(keys, { expiresAt: '2026-09-23T00:00:00Z' });
    expect(verifyLicense(expired, [keys.publicKey], NOW).ok).toBe(true);
  });

  it.each([
    ['not three parts', 'wbl1.abc'],
    ['another format version', license(keys).replace(/^wbl1/, 'wbl2')],
    ['an empty string', ''],
    ['a character outside base64url', 'wbl1.ab+c.def'],
  ])('is malformed for %s', (_name, text) => {
    expect(verifyLicense(text, [keys.publicKey], NOW)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('is malformed when a correctly signed payload is not JSON, not the schema, or expires before it starts', () => {
    const segment = Buffer.from('not json', 'utf8').toString('base64url');
    const notJson = `wbl1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), keys.privateKey).toString('base64url')}`;
    const unknownKey = signLicense({ ...PAYLOAD, serverId: 'abc' }, keys.privateKey);
    const backwards = license(keys, { expiresAt: '2026-08-01T00:00:00Z' });
    for (const text of [notJson, unknownKey, backwards]) {
      expect(verifyLicense(text, [keys.publicKey], NOW)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a flipped byte in the payload, a wrong key and a truncated signature', () => {
    const text = license(keys);
    const [format, body, signature] = text.split('.') as [string, string, string];
    const flipped = `${format}.${body.slice(0, -2)}${body.at(-2) === 'A' ? 'B' : 'A'}${body.at(-1)}.${signature}`;
    expect(verifyLicense(flipped, [keys.publicKey], NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyLicense(text, [other.publicKey], NOW)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyLicense(`${format}.${body}.${signature.slice(0, 10)}`, [keys.publicKey], NOW)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('is not yet valid when issued after the server clock, and the message names that clock', () => {
    const future = license(keys, { issuedAt: '2026-09-25T00:00:00Z', expiresAt: '2027-09-25T00:00:00Z' });
    const result = verifyLicense(future, [keys.publicKey], NOW);
    expect(result).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    expect(result.ok === false && result.message).toContain('2026-09-24T12:00:00.000Z');
  });
});

it('ships one Ed25519 production key, which a test key does not satisfy', () => {
  expect(PRODUCTION_PUBLIC_KEYS).toHaveLength(1);
  expect(PRODUCTION_PUBLIC_KEYS[0]!.asymmetricKeyType).toBe('ed25519');
  expect(verifyLicense(license(keys), PRODUCTION_PUBLIC_KEYS, NOW)).toMatchObject({ reason: 'bad-signature' });
});
