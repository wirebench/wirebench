/**
 * Recovery codes (two-step sign-in spec §3.4): ten one-use codes of ten characters, `xxxxx-xxxxx`, from the
 * 32-character alphabet that leaves out `i`, `l`, `o` and `u`; typed `i` and `l` read as `1` and `o` as `0`, and
 * case, spaces and dashes are ignored. Stored as HMAC-SHA-256 under a key of the person's own (`keys.ts`), so a
 * copied table gives nothing to guess against without the tenant's data key.
 */
import { createHmac, randomBytes } from 'node:crypto';

export const RECOVERY_CODE_COUNT = 10;
const ALPHABET = '0123456789abcdefghjkmnpqrstvwxyz';
const LENGTH = 10;

export function newRecoveryCodes(): string[] {
  const codes = new Set<string>();
  while (codes.size < RECOVERY_CODE_COUNT) {
    // 32 letters: a byte's low five bits pick one without bias.
    const raw = [...randomBytes(LENGTH)].map((byte) => ALPHABET[byte & 31]).join('');
    codes.add(`${raw.slice(0, 5)}-${raw.slice(5)}`);
  }
  return [...codes];
}

/** The code as stored: lower case, look-alikes mapped, separators dropped; `undefined` when it cannot be one. */
export function normaliseRecoveryCode(text: string): string | undefined {
  const plain = text.toLowerCase().replace(/[\s-]/g, '').replace(/[il]/g, '1').replace(/o/g, '0');
  return plain.length === LENGTH && [...plain].every((c) => ALPHABET.includes(c)) ? plain : undefined;
}

export function recoveryCodeHash(key: Buffer, code: string): string {
  return createHmac('sha256', key)
    .update(normaliseRecoveryCode(code) ?? code)
    .digest('hex');
}
