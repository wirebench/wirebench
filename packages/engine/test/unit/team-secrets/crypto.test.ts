import { describe, expect, it } from 'vitest';
import { WirebenchError } from '../../../src/errors.js';
import {
  decryptValue,
  encryptValue,
  newDataKey,
  unwrapDataKey,
  wrapDataKey,
} from '../../../src/team-secrets/envelope.js';
import { TEAM_SECRETS_MESSAGES, teamSecretsError } from '../../../src/team-secrets/errors.js';
import {
  base32,
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
});

describe('signatures', () => {
  it('writes canonical JSON: sorted keys at every depth, no whitespace, undefined dropped', () => {
    expect(canonicalJson({ b: 1, a: { d: [2, { z: 1, y: 2 }], c: 'x' }, u: undefined })).toBe(
      '{"a":{"c":"x","d":[2,{"y":2,"z":1}]},"b":1}',
    );
    expect(canonicalJson({ a: 1, b: 2 })).toBe(canonicalJson({ b: 2, a: 1 }));
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
