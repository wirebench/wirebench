import { createCipheriv, diffieHellman, generateKeyPairSync, hkdfSync } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import {
  decryptValue,
  encryptValue,
  newDataKey,
  unwrapDataKey,
  WRAP_INFO,
  wrapDataKey,
} from '../../../src/team-secrets/envelope.js';
import { TEAM_SECRETS_MESSAGES, teamSecretsError } from '../../../src/team-secrets/errors.js';
import {
  base32,
  base64url,
  encryptionPublicKey,
  fingerprintOf,
  fromBase64url,
  generateMachineKeys,
  KEY_ID_PATTERN,
  keyIdOf,
  parseMachineKeys,
  serializeMachineKeys,
} from '../../../src/team-secrets/keys.js';
import { canonicalJson, signDocument, verifyDocument } from '../../../src/team-secrets/sign.js';

describe('machine keys (team secrets §2, §4)', () => {
  it('encodes base32 as RFC 4648 without padding', () => {
    expect(base32(Buffer.from('f'))).toBe('MY');
    expect(base32(Buffer.from('fo'))).toBe('MZXQ');
    expect(base32(Buffer.from('foobar'))).toBe('MZXW6YTBOI');
  });

  it('generates 32-byte public keys, a 26-character key id and a grouped fingerprint', () => {
    const keys = generateMachineKeys();
    expect(fromBase64url(keys.encryptionKey)).toHaveLength(32);
    expect(fromBase64url(keys.signingKey)).toHaveLength(32);
    expect(keys.keyId).toMatch(KEY_ID_PATTERN);
    expect(keys.keyId).toBe(keyIdOf(keys));
    expect(fingerprintOf(keys)).toMatch(/^[0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4} [0-9a-f]{4}$/);
    expect(generateMachineKeys().keyId).not.toBe(keys.keyId);
  });

  it('round-trips through its stored form and refuses one whose key id does not match', () => {
    const keys = generateMachineKeys();
    expect(parseMachineKeys(serializeMachineKeys(keys))).toEqual(keys);
    const other = generateMachineKeys();
    expect(parseMachineKeys(JSON.stringify({ ...keys, keyId: other.keyId }))).toBeUndefined();
    expect(parseMachineKeys('not json')).toBeUndefined();
  });

  it('refuses a stored form whose public key does not match its own private half', () => {
    const keys = generateMachineKeys();
    const other = generateMachineKeys();
    // A swapped public key still makes a self-consistent keyId (computed from the two public fields), so
    // only deriving the public key from the private half catches this.
    const tampered = { ...keys, encryptionKey: other.encryptionKey };
    expect(parseMachineKeys(JSON.stringify({ ...tampered, keyId: keyIdOf(tampered) }))).toBeUndefined();
    const tamperedSigning = { ...keys, signingKey: other.signingKey };
    expect(parseMachineKeys(JSON.stringify({ ...tamperedSigning, keyId: keyIdOf(tamperedSigning) }))).toBeUndefined();
  });

  describe('fromBase64url', () => {
    it('decodes strict base64url', () => {
      expect(fromBase64url('Zm9vYmFy')).toEqual(Buffer.from('foobar'));
    });

    it('refuses padding, standard base64 characters and whitespace', () => {
      expect(() => fromBase64url('Zm9vYmFy=')).toThrow(WirebenchError);
      expect(() => fromBase64url('Zm9vYmFy==')).toThrow(WirebenchError);
      expect(() => fromBase64url('a+b/c')).toThrow(WirebenchError);
      expect(() => fromBase64url('Zm9v\nYmFy')).toThrow(WirebenchError);
      expect(() => fromBase64url(' Zm9vYmFy')).toThrow(WirebenchError);
      expect(() => fromBase64url('Zm9vYmFy ')).toThrow(WirebenchError);
    });
  });
});

describe('signatures', () => {
  it('writes canonical JSON: sorted keys at every depth, no whitespace, undefined dropped', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
  });

  it('refuses anything that is not a JSON value', () => {
    expect(() => canonicalJson(NaN)).toThrow(WirebenchError);
    expect(() => canonicalJson(Infinity)).toThrow(WirebenchError);
    expect(() => canonicalJson(-Infinity)).toThrow(WirebenchError);
    expect(() => canonicalJson(new Date())).toThrow(WirebenchError);
    expect(() => canonicalJson(new Map())).toThrow(WirebenchError);
    expect(() => canonicalJson(new Set())).toThrow(WirebenchError);
    expect(() => canonicalJson([1, undefined, 2])).toThrow(WirebenchError);
    expect(() => canonicalJson(class Foo {})).toThrow(WirebenchError);
    class Bar {
      readonly a = 1;
    }
    expect(() => canonicalJson(new Bar())).toThrow(WirebenchError);
    expect(() => canonicalJson({ a: [{ b: new Date() }] })).toThrow(WirebenchError);
  });

  it('normalises -0 to 0, since JSON and YAML cannot round-trip a negative zero', () => {
    expect(canonicalJson(-0)).toBe('0');
  });

  it('makes signDocument throw and verifyDocument return false for a non-canonical document', () => {
    const keys = generateMachineKeys();
    expect(() => signDocument({ at: new Date() }, keys)).toThrow(WirebenchError);
    const signed = signDocument({ a: 1 }, keys);
    expect(verifyDocument({ ...signed, at: new Date() }, keys.signingKey)).toBe(false);
  });

  it('verifies a signed document and refuses a changed field, another key or a bad signature', () => {
    const keys = generateMachineKeys();
    const signed = signDocument({ version: 1, key: 'K', at: '2026-09-26T10:00:00.000Z' }, keys);
    expect(verifyDocument(signed, keys.signingKey)).toBe(true);
    expect(verifyDocument({ ...signed, at: '2026-09-26T11:00:00.000Z' }, keys.signingKey)).toBe(false);
    expect(verifyDocument(signed, generateMachineKeys().signingKey)).toBe(false);
    expect(verifyDocument({ ...signed, signature: 'AAAA' }, keys.signingKey)).toBe(false);
    expect(verifyDocument(signed, 'not-a-key')).toBe(false);
  });

  it('signs the document without its signature, so re-signing replaces it', () => {
    const keys = generateMachineKeys();
    const once = signDocument({ a: 1 }, keys);
    const twice = signDocument(once, keys);
    expect(verifyDocument(twice, keys.signingKey)).toBe(true);
    expect(Object.keys(twice).sort()).toEqual(['a', 'signature']);
  });
});

describe('envelope', () => {
  it('encrypts a value and decrypts it with the same data key and entry id', () => {
    const dataKey = newDataKey();
    const cipher = encryptValue('hunter2', dataKey, 'ENTRYAAAAAAAAAAAAAAAAAAAAA');
    expect(cipher).not.toContain('hunter2');
    expect(decryptValue(cipher, dataKey, 'ENTRYAAAAAAAAAAAAAAAAAAAAA')).toBe('hunter2');
  });

  it('refuses a cipher moved to another entry (the entry id is the additional data)', () => {
    const dataKey = newDataKey();
    const cipher = encryptValue('hunter2', dataKey, 'ENTRYAAAAAAAAAAAAAAAAAAAAA');
    expect(() => decryptValue(cipher, dataKey, 'ENTRYBBBBBBBBBBBBBBBBBBBBB')).toThrow(WirebenchError);
  });

  it('refuses a tampered cipher, a wrong data key and a truncated cipher', () => {
    const dataKey = newDataKey();
    const cipher = encryptValue('hunter2', dataKey, 'E');
    const bytes = fromBase64url(cipher);
    bytes[14] = (bytes[14] ?? 0) ^ 0xff;
    expect(() => decryptValue(bytes.toString('base64url'), dataKey, 'E')).toThrow(/could not be decrypted/);
    expect(() => decryptValue(cipher, newDataKey(), 'E')).toThrow(WirebenchError);
    expect(() => decryptValue('AAAA', dataKey, 'E')).toThrow(WirebenchError);
  });

  it('wraps a data key for a recipient, who alone can unwrap it', () => {
    const alice = generateMachineKeys();
    const bob = generateMachineKeys();
    const dataKey = newDataKey();
    const wrap = wrapDataKey(dataKey, alice.encryptionKey);
    expect(unwrapDataKey(wrap, alice).equals(dataKey)).toBe(true);
    expect(() => unwrapDataKey(wrap, bob)).toThrow(WirebenchError);
    expect(wrapDataKey(dataKey, alice.encryptionKey)).not.toBe(wrap);
  });

  it('refuses a tampered wrap', () => {
    const alice = generateMachineKeys();
    const bytes = fromBase64url(wrapDataKey(newDataKey(), alice.encryptionKey));
    bytes[40] = (bytes[40] ?? 0) ^ 0x01;
    expect(() => unwrapDataKey(bytes.toString('base64url'), alice)).toThrow(WirebenchError);
  });

  it('refuses a data key that is not 32 bytes, without an OpenSSL error leaking through', () => {
    const short = Buffer.alloc(16);
    expect(() => encryptValue('x', short, 'E')).toThrow(WirebenchError);
    expect(() => decryptValue('AAAA', short, 'E')).toThrow(WirebenchError);
    expect(() => wrapDataKey(short, generateMachineKeys().encryptionKey)).toThrow(WirebenchError);
  });

  it('refuses a malformed or low-order recipient key, coded and without the key material in the message', () => {
    const dataKey = newDataKey();
    expect(() => wrapDataKey(dataKey, 'not-base64url!!')).toThrow(WirebenchError);
    expect(() => wrapDataKey(dataKey, base64url(Buffer.alloc(16)))).toThrow(WirebenchError);
    // The all-zero point is a known low-order X25519 point: ECDH with it always yields an all-zero secret.
    const lowOrder = base64url(Buffer.alloc(32));
    let error: unknown;
    try {
      wrapDataKey(dataKey, lowOrder);
    } catch (caught) {
      error = caught;
    }
    expect(error).toBeInstanceOf(WirebenchError);
    expect((error as WirebenchError).code).toBe('team-secrets-bad-key');
    expect((error as WirebenchError).message).not.toContain(lowOrder);
  });

  it('refuses an unwrapped data key that is not 32 bytes (a forged wrap)', () => {
    const alice = generateMachineKeys();
    const ephemeral = generateKeyPairSync('x25519');
    const ephemeralPublic = fromBase64url(String(ephemeral.publicKey.export({ format: 'jwk' }).x));
    const shared = diffieHellman({
      privateKey: ephemeral.privateKey,
      publicKey: encryptionPublicKey(alice.encryptionKey),
    });
    const sealingKey = Buffer.from(
      hkdfSync('sha256', shared, Buffer.concat([ephemeralPublic, fromBase64url(alice.encryptionKey)]), WRAP_INFO, 32),
    );
    const nonce = Buffer.alloc(12);
    const cipher = createCipheriv('aes-256-gcm', sealingKey, nonce);
    const forgedDataKey = Buffer.alloc(16, 7); // the wrong length, on purpose
    const sealed = Buffer.concat([cipher.update(forgedDataKey), cipher.final()]);
    const forgedWrap = Buffer.concat([ephemeralPublic, nonce, sealed, cipher.getAuthTag()]).toString('base64url');
    expect(() => unwrapDataKey(forgedWrap, alice)).toThrow(WirebenchError);
    expect(() => unwrapDataKey(forgedWrap, alice)).toThrow(/could not be decrypted/);
  });
});

describe('errors (§3.8)', () => {
  it('carries the spec wording for every code', () => {
    expect(TEAM_SECRETS_MESSAGES['team-secrets-pending']).toBe(
      'This machine is waiting for an admin to approve it for team secrets.',
    );
    const error = teamSecretsError('team-secrets-last-admin');
    expect(error.code).toBe('team-secrets-last-admin');
    expect(error.message).toBe('A workspace needs at least one admin for team secrets.');
  });
});
