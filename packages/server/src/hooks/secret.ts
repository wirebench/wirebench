/**
 * Catch URL secrets (webhook-capture spec §3.2, §5): 128 bits from `crypto.randomBytes(16)`, written
 * in Crockford base32 as 26 upper-case characters, the alphabet ULIDs use. 26 × 5 = 130 bits, so the
 * first character only ever carries the top 3 bits (`0`–`7`), which `CATCH_SECRET_PATTERN` allows.
 */
import { randomBytes } from 'node:crypto';

const CROCKFORD = '0123456789ABCDEFGHJKMNPQRSTVWXYZ';
const SECRET_BYTES = 16;
const SECRET_LENGTH = 26;

/** 16 bytes, most significant first, as 26 Crockford characters. */
export function crockford128(bytes: Uint8Array): string {
  if (bytes.length !== SECRET_BYTES) throw new RangeError(`a catch URL secret is ${SECRET_BYTES} bytes`);
  let value = 0n;
  for (const byte of bytes) value = (value << 8n) | BigInt(byte);
  let text = '';
  for (let index = 0; index < SECRET_LENGTH; index += 1) {
    text = CROCKFORD.charAt(Number(value & 31n)) + text;
    value >>= 5n;
  }
  return text;
}

/** A fresh secret. `random` exists for tests; production uses the CSPRNG. */
export function mintCatchSecret(random: (size: number) => Uint8Array = randomBytes): string {
  return crockford128(random(SECRET_BYTES));
}
