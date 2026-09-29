/**
 * Catch URL signature secrets at rest (webhook-signatures §3.1): AES-256-GCM under the key from
 * `WIREBENCH_SERVER_HOOKS_SECRET_KEY`, laid out `version(1) ‖ iv(12) ‖ tag(16) ‖ ciphertext`. The
 * version byte leaves room for another layout; rotating the key is out of scope (§1.2).
 */
import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';

const VERSION = 1;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + IV_BYTES + TAG_BYTES;

/** A fresh IV per seal; `iv` exists for the known-answer test only. */
export function seal(key: Buffer, plaintext: string, iv: Buffer = randomBytes(IV_BYTES)): Buffer {
  const cipher = createCipheriv('aes-256-gcm', key, iv);
  const ciphertext = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  return Buffer.concat([Buffer.from([VERSION]), iv, cipher.getAuthTag(), ciphertext]);
}

/** @throws Error when the box is not one this build wrote, or does not authenticate under `key`. */
export function open(key: Buffer, sealed: Buffer): string {
  if (sealed.length < HEADER_BYTES || sealed[0] !== VERSION) throw new Error('sealed secret: unknown format');
  const decipher = createDecipheriv('aes-256-gcm', key, sealed.subarray(1, 1 + IV_BYTES));
  decipher.setAuthTag(sealed.subarray(1 + IV_BYTES, HEADER_BYTES));
  return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]).toString('utf8');
}

/**
 * The last four characters (§3.2), shown to editors as *● set …f789*. A secret shorter than eight
 * gets none: four of seven characters would give most of it away.
 */
export function hintOf(secret: string): string | null {
  return secret.length >= 8 ? secret.slice(-4) : null;
}
