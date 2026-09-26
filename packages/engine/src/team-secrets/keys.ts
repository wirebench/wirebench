/**
 * Machine keys for team secrets (team-secrets spec §2, §4): one X25519 pair to decrypt and one Ed25519
 * pair to sign, per machine per workspace. Keys travel as base64url of their raw 32 bytes, which is what
 * a JWK's `x` and `d` already are, so `node:crypto` imports them without any DER handling.
 *
 * Pure: no I/O. The desktop keeps the private halves in its keychain-backed store; nothing else does.
 */
import { createHash, createPrivateKey, createPublicKey, generateKeyPairSync, type KeyObject } from 'node:crypto';
import { teamSecretsError } from './errors.js';

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

const BASE64URL_PATTERN = /^[A-Za-z0-9_-]*$/;

/**
 * Strict base64url decoding: Node's own decoder tolerates padding, standard `+`/`/`, and embedded
 * whitespace, silently turning any of those into *some* bytes. A team-secrets field is either exactly
 * base64url or it is corrupt, so this instead requires the alphabet `[A-Za-z0-9_-]` with no padding, and
 * that re-encoding the decoded bytes reproduces the input exactly (catching a truncated last group, which
 * the pattern alone would not).
 *
 * @throws WirebenchError `team-secrets-bad-key` if `text` is not strictly base64url.
 */
export function fromBase64url(text: string): Buffer {
  if (!BASE64URL_PATTERN.test(text)) {
    throw teamSecretsError('team-secrets-bad-key');
  }
  const bytes = Buffer.from(text, 'base64url');
  if (base64url(bytes) !== text) {
    throw teamSecretsError('team-secrets-bad-key');
  }
  return bytes;
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

const PUBLIC_KEY_LENGTH = 32;

/** @throws WirebenchError `team-secrets-bad-key` unless `bytes` is exactly `length` long. */
function assertKeyLength(bytes: Buffer, length: number): Buffer {
  if (bytes.length !== length) {
    throw teamSecretsError('team-secrets-bad-key');
  }
  return bytes;
}

function publicDigest(keys: MachinePublicKeys): Buffer {
  return createHash('sha256')
    .update(assertKeyLength(fromBase64url(keys.encryptionKey), PUBLIC_KEY_LENGTH))
    .update(assertKeyLength(fromBase64url(keys.signingKey), PUBLIC_KEY_LENGTH))
    .digest();
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
  assertKeyLength(fromBase64url(raw), PUBLIC_KEY_LENGTH);
  return createPublicKey({ key: { kty: 'OKP', crv: 'X25519', x: raw }, format: 'jwk' });
}

export function encryptionPrivateKey(keys: MachineKeys): KeyObject {
  return createPrivateKey({
    key: { kty: 'OKP', crv: 'X25519', x: keys.encryptionKey, d: keys.encryptionPrivate },
    format: 'jwk',
  });
}

export function signingPublicKey(raw: string): KeyObject {
  assertKeyLength(fromBase64url(raw), PUBLIC_KEY_LENGTH);
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

/** The public half (base64url `x`) a JWK private key exports, i.e. what its private half actually is a key for. */
function publicHalfOf(privateKey: KeyObject): string {
  return String((createPublicKey(privateKey).export({ format: 'jwk' }) as { x: unknown }).x);
}

/**
 * Reads the stored form back; `undefined` for anything malformed, whose key id does not match its public
 * keys, or whose public keys are not the ones its private halves actually derive (a stored file could
 * otherwise carry a public key from one machine paired with a private key from another).
 */
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
  try {
    if (keyIdOf(keys) !== keys.keyId) {
      return undefined;
    }
    if (publicHalfOf(encryptionPrivateKey(keys)) !== keys.encryptionKey) {
      return undefined;
    }
    if (publicHalfOf(signingPrivateKey(keys)) !== keys.signingKey) {
      return undefined;
    }
  } catch {
    return undefined;
  }
  return keys;
}
