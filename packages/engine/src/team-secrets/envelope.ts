/**
 * The vault envelope (§4): a value is encrypted once with a random data key (AES-256-GCM, the vault entry id
 * as additional data, so a cipher cannot be moved to another secret), and the data key is wrapped for each
 * approved machine. A wrap is a fresh ephemeral X25519 public key, a nonce and the sealed data key; the
 * sealing key is HKDF-SHA256 of the ECDH secret, salted with both public keys.
 *
 * Every binary field is base64url: `nonce || ciphertext || tag` for a cipher, `ephemeral || nonce ||
 * sealed || tag` for a wrap.
 */
import {
  createCipheriv,
  createDecipheriv,
  diffieHellman,
  generateKeyPairSync,
  hkdfSync,
  randomBytes,
  type KeyObject,
} from 'node:crypto';
import { WirebenchError } from '../errors.js';
import { teamSecretsError } from './errors.js';
import { base64url, encryptionPrivateKey, encryptionPublicKey, fromBase64url, type MachineKeys } from './keys.js';

export const WRAP_INFO = 'wirebench-team-secrets-v1-wrap';

const NONCE_BYTES = 12;
const TAG_BYTES = 16;
const KEY_BYTES = 32;
const PUBLIC_KEY_BYTES = 32;

function failed(cause?: unknown): WirebenchError {
  return teamSecretsError('team-secrets-decrypt-failed', cause !== undefined ? { cause } : undefined);
}

/** A malformed or out-of-range key or data key. Never carries the offending key material. */
function badKey(): WirebenchError {
  return teamSecretsError('team-secrets-bad-key');
}

function seal(key: Buffer, plaintext: Buffer, aad?: Buffer): Buffer {
  const nonce = randomBytes(NONCE_BYTES);
  const cipher = createCipheriv('aes-256-gcm', key, nonce);
  if (aad !== undefined) {
    cipher.setAAD(aad);
  }
  const body = Buffer.concat([cipher.update(plaintext), cipher.final()]);
  return Buffer.concat([nonce, body, cipher.getAuthTag()]);
}

function open(key: Buffer, sealed: Buffer, aad?: Buffer): Buffer {
  if (sealed.length < NONCE_BYTES + TAG_BYTES) {
    throw failed();
  }
  try {
    const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(0, NONCE_BYTES));
    if (aad !== undefined) {
      decipher.setAAD(aad);
    }
    decipher.setAuthTag(sealed.subarray(sealed.length - TAG_BYTES));
    return Buffer.concat([decipher.update(sealed.subarray(NONCE_BYTES, sealed.length - TAG_BYTES)), decipher.final()]);
  } catch (error) {
    throw failed(error);
  }
}

export function newDataKey(): Buffer {
  return randomBytes(KEY_BYTES);
}

/** @throws WirebenchError `team-secrets-bad-key` if `dataKey` is not exactly 32 bytes. */
function assertDataKey(dataKey: Buffer): void {
  if (dataKey.length !== KEY_BYTES) {
    throw badKey();
  }
}

/**
 * A recipient's X25519 public key as a `KeyObject`, and the ECDH secret computed with it. Throws
 * `team-secrets-bad-key` for anything that is not a well-formed, non-degenerate point: malformed
 * base64url, the wrong length, or a low-order point whose shared secret is all-zero — never the raw
 * `TypeError`/`RangeError`/OpenSSL error, and never the key material itself.
 */
function sharedSecretWith(privateKey: KeyObject, recipientRaw: string): Buffer {
  let publicKey: KeyObject;
  try {
    publicKey = encryptionPublicKey(recipientRaw);
  } catch {
    throw badKey();
  }
  let shared: Buffer;
  try {
    shared = diffieHellman({ privateKey, publicKey });
  } catch {
    throw badKey();
  }
  if (shared.equals(Buffer.alloc(shared.length))) {
    // A low-order point collapses ECDH to an all-zero secret regardless of the private key.
    throw badKey();
  }
  return shared;
}

export function encryptValue(value: string, dataKey: Buffer, entryId: string): string {
  assertDataKey(dataKey);
  return base64url(seal(dataKey, Buffer.from(value, 'utf8'), Buffer.from(entryId, 'utf8')));
}

/** @throws WirebenchError `team-secrets-decrypt-failed` | `team-secrets-bad-key` */
export function decryptValue(cipher: string, dataKey: Buffer, entryId: string): string {
  assertDataKey(dataKey);
  return open(dataKey, fromBase64url(cipher), Buffer.from(entryId, 'utf8')).toString('utf8');
}

function wrapKey(shared: Buffer, ephemeral: Buffer, recipient: Buffer): Buffer {
  return Buffer.from(hkdfSync('sha256', shared, Buffer.concat([ephemeral, recipient]), WRAP_INFO, KEY_BYTES));
}

/** @throws WirebenchError `team-secrets-bad-key` */
export function wrapDataKey(dataKey: Buffer, recipientEncryptionKey: string): string {
  assertDataKey(dataKey);
  const pair = generateKeyPairSync('x25519');
  const ephemeral = fromBase64url(String(pair.publicKey.export({ format: 'jwk' }).x));
  const shared = sharedSecretWith(pair.privateKey, recipientEncryptionKey);
  const key = wrapKey(shared, ephemeral, fromBase64url(recipientEncryptionKey));
  return base64url(Buffer.concat([ephemeral, seal(key, dataKey)]));
}

/** @throws WirebenchError `team-secrets-decrypt-failed` | `team-secrets-bad-key` */
export function unwrapDataKey(wrap: string, keys: MachineKeys): Buffer {
  const bytes = fromBase64url(wrap);
  if (bytes.length < PUBLIC_KEY_BYTES + NONCE_BYTES + TAG_BYTES) {
    throw failed();
  }
  const ephemeral = bytes.subarray(0, PUBLIC_KEY_BYTES);
  const shared = sharedSecretWith(encryptionPrivateKey(keys), base64url(ephemeral));
  const dataKey = open(wrapKey(shared, ephemeral, fromBase64url(keys.encryptionKey)), bytes.subarray(PUBLIC_KEY_BYTES));
  if (dataKey.length !== KEY_BYTES) {
    throw failed();
  }
  return dataKey;
}
