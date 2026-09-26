/**
 * Machine keys for team secrets (team-secrets spec §2, §4): one X25519 pair to decrypt and one Ed25519
 * pair to sign, per machine per workspace. Keys travel as base64url of their raw 32 bytes, which is what
 * a JWK's `x` and `d` already are, so `node:crypto` imports them without any DER handling.
 *
 * Pure: no I/O. The desktop keeps the private halves in its keychain-backed store; nothing else does.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';

/** A key id: the first 26 base32 characters of SHA-256 over both public keys. */
export const KEY_ID_PATTERN = /^[A-Z2-7]{26}$/;

/** The two public keys a key request publishes. */
export interface MachinePublicKeys {
  /** X25519, base64url of 32 bytes. */
  readonly encryptionKey: string;
  /** Ed25519, base64url of 32 bytes. */
  readonly signingKey: string;
}

/** A machine's full key set. The private halves never leave the desktop's main process. */
export interface MachineKeys extends MachinePublicKeys {
  readonly keyId: string;
  readonly encryptionPrivate: string;
  readonly signingPrivate: string;
}

export function base64url(bytes: Uint8Array): string {
  return Buffer.from(bytes).toString('base64url');
}

export function fromBase64url(text: string): Buffer {
  return Buffer.from(text, 'base64url');
}

const BASE32_ALPHABET = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

/** RFC 4648 base32 without padding. */
export function base32(bytes: Uint8Array): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    // Only the bits not yet written are kept (fewer than 13), so the number never overflows.
    value = ((value << 8) | byte) & 0x1fff;
    bits += 8;
    while (bits >= 5) {
      out += BASE32_ALPHABET[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) {
    out += BASE32_ALPHABET[(value << (5 - bits)) & 31];
  }
  return out;
}

function publicDigest(keys: MachinePublicKeys): Buffer {
  return createHash('sha256').update(fromBase64url(keys.encryptionKey)).update(fromBase64url(keys.signingKey)).digest();
}

export function keyIdOf(keys: MachinePublicKeys): string {
  return base32(publicDigest(keys)).slice(0, 26);
}

/** What an admin reads out to the person (§3.2): the first 16 hex of the same digest, in groups of four. */
export function fingerprintOf(keys: MachinePublicKeys): string {
  return publicDigest(keys).toString('hex').slice(0, 16).match(/.{4}/g)?.join(' ') ?? '';
}

export function generateMachineKeys(): MachineKeys {
  const encryption = generateKeyPairSync('x25519').privateKey.export({ format: 'jwk' });
  const signing = generateKeyPairSync('ed25519').privateKey.export({ format: 'jwk' });
  const publicKeys: MachinePublicKeys = { encryptionKey: String(encryption.x), signingKey: String(signing.x) };
  return {
    ...publicKeys,
    keyId: keyIdOf(publicKeys),
    encryptionPrivate: String(encryption.d),
    signingPrivate: String(signing.d),
  };
}

export function encryptionPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

export function encryptionPrivateKey(keys: MachineKeys): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: keys.encryptionKey, d: keys.encryptionPrivate },
    format: 'jwk',
  });
}

export function signingPublicKey(raw: string): KeyObject {
  return createPublicKey({ key: { kty: 'OKP', crv: 'Ed25519', x: raw }, format: 'jwk' });
}

export function signingPrivateKey(keys: MachineKeys): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'Ed25519', x: keys.signingKey, d: keys.signingPrivate },
    format: 'jwk',
  });
}

/** The stored form, kept in the keychain-backed store only. */
export function serializeMachineKeys(keys: MachineKeys): string {
  return JSON.stringify({
    keyId: keys.keyId,
    encryptionKey: keys.encryptionKey,
    encryptionPrivate: keys.encryptionPrivate,
    signingKey: keys.signingKey,
    signingPrivate: keys.signingPrivate,
  });
}

/** Reads the stored form back; `undefined` for anything malformed or whose key id does not match its keys. */
export function parseMachineKeys(text: string): MachineKeys | undefined {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== 'object' || parsed === null) {
    return undefined;
  }
  const fields = parsed as Record<string, unknown>;
  const names = ['keyId', 'encryptionKey', 'encryptionPrivate', 'signingKey', 'signingPrivate'] as const;
  if (names.some((name) => typeof fields[name] !== 'string')) {
    return undefined;
  }
  const keys = Object.fromEntries(names.map((name) => [name, fields[name]])) as unknown as MachineKeys;
  return keyIdOf(keys) === keys.keyId ? keys : undefined;
}
