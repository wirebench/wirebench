import { sign } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { verifyLicense } from '../../../src/licensing/format.js';
import { PRODUCTION_PUBLIC_KEYS } from '../../../src/licensing/keys.js';
import { license, PAYLOAD, signLicense, testKeys } from '../../helpers/licensing.js';

const keys = testKeys();
const other = testKeys();
const NOW = new Date('2026-09-24T12:00:00Z');
const SERVER = '0b6f3c2e-5d1a-4c7e-9f3b-2a8d4e6c1f90';

describe('verifyLicense (licensing spec §3.1, §3.2)', () => {
  it('round-trips a signed payload', () => {
    expect(verifyLicense(license(keys), [keys.publicKey], NOW, SERVER)).toEqual({ ok: true, license: PAYLOAD });
  });

  it('accepts surrounding whitespace from a paste', () => {
    expect(verifyLicense(`  ${license(keys)}\n`, [keys.publicKey], NOW, SERVER).ok).toBe(true);
  });

  it('tries every key, so a rotation can ship two', () => {
    expect(verifyLicense(license(keys), [other.publicKey, keys.publicKey], NOW, SERVER).ok).toBe(true);
  });

  it('does not look at expiry: a license that expired yesterday verifies', () => {
    const expired = license(keys, { expiresAt: '2026-09-23T00:00:00Z' });
    expect(verifyLicense(expired, [keys.publicKey], NOW, SERVER).ok).toBe(true);
  });

  it.each([
    ['not three parts', 'wbl1.abc'],
    ['another format version', license(keys).replace(/^wbl1/, 'wbl2')],
    ['an empty string', ''],
    ['a character outside base64url', 'wbl1.ab+c.def'],
  ])('is malformed for %s', (_name, text) => {
    expect(verifyLicense(text, [keys.publicKey], NOW, SERVER)).toMatchObject({ ok: false, reason: 'malformed' });
  });

  it('is malformed when a correctly signed payload is not JSON, not the schema, or expires before it starts', () => {
    const segment = Buffer.from('not json', 'utf8').toString('base64url');
    const notJson = `wbl1.${segment}.${sign(null, Buffer.from(segment, 'ascii'), keys.privateKey).toString('base64url')}`;
    const unknownKey = signLicense({ ...PAYLOAD, bogus: 'abc' }, keys.privateKey);
    const backwards = license(keys, { expiresAt: '2026-08-01T00:00:00Z' });
    for (const text of [notJson, unknownKey, backwards]) {
      expect(verifyLicense(text, [keys.publicKey], NOW, SERVER)).toMatchObject({ ok: false, reason: 'malformed' });
    }
  });

  it('refuses a flipped byte in the payload, a wrong key and a truncated signature', () => {
    const text = license(keys);
    const [format, body, signature] = text.split('.') as [string, string, string];
    const flipped = `${format}.${body.slice(0, -2)}${body.at(-2) === 'A' ? 'B' : 'A'}${body.at(-1)}.${signature}`;
    expect(verifyLicense(flipped, [keys.publicKey], NOW, SERVER)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyLicense(text, [other.publicKey], NOW, SERVER)).toMatchObject({ ok: false, reason: 'bad-signature' });
    expect(verifyLicense(`${format}.${body}.${signature.slice(0, 10)}`, [keys.publicKey], NOW, SERVER)).toMatchObject({
      ok: false,
      reason: 'bad-signature',
    });
  });

  it('is not yet valid when issued after the server clock, and the message names that clock', () => {
    const future = license(keys, { issuedAt: '2026-09-25T00:00:00Z', expiresAt: '2027-09-25T00:00:00Z' });
    const result = verifyLicense(future, [keys.publicKey], NOW, SERVER);
    expect(result).toMatchObject({ ok: false, reason: 'not-yet-valid' });
    expect(result.ok === false && result.message).toContain('2026-09-24T12:00:00.000Z');
  });
});

describe('the server binding (license-binding spec §3.3)', () => {
  const OTHER = '11111111-2222-4333-8444-555555555555';
  it('verifies a license bound to this server', () => {
    expect(verifyLicense(license(keys, { serverId: SERVER }), [keys.publicKey], NOW, SERVER)).toEqual({
      ok: true,
      license: { ...PAYLOAD, serverId: SERVER },
    });
  });
  it('is wrong-server for another server, naming both ids', () => {
    expect(verifyLicense(license(keys, { serverId: OTHER }), [keys.publicKey], NOW, SERVER)).toEqual({
      ok: false,
      reason: 'wrong-server',
      message: `This license was issued for server ${OTHER}. This server is ${SERVER}. Ask for a license issued for this server.`,
    });
  });
  it('verifies an unbound license on any server', () => {
    expect(verifyLicense(license(keys), [keys.publicKey], NOW, OTHER).ok).toBe(true);
  });
  it('checks the signature before the binding', () => {
    expect(verifyLicense(license(other, { serverId: OTHER }), [keys.publicKey], NOW, SERVER)).toMatchObject({
      reason: 'bad-signature',
    });
  });
  it('checks the binding before the clock', () => {
    const future = license(keys, {
      serverId: OTHER,
      issuedAt: '2026-12-01T00:00:00Z',
      expiresAt: '2027-12-01T00:00:00Z',
    });
    expect(verifyLicense(future, [keys.publicKey], NOW, SERVER)).toMatchObject({ reason: 'wrong-server' });
  });
});

it('ships one Ed25519 production key, which a test key does not satisfy', () => {
  expect(PRODUCTION_PUBLIC_KEYS).toHaveLength(1);
  expect(PRODUCTION_PUBLIC_KEYS[0]!.asymmetricKeyType).toBe('ed25519');
  expect(verifyLicense(license(keys), PRODUCTION_PUBLIC_KEYS, NOW, SERVER)).toMatchObject({ reason: 'bad-signature' });
});
