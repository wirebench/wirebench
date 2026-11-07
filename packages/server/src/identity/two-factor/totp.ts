/**
 * Authenticator codes (two-step sign-in spec §3.4): RFC 6238 with SHA-1, six digits and 30-second steps, the
 * defaults every authenticator app reads from an `otpauth://` URI. A code is accepted for the current step and
 * one either side, and only for a step after the last one this person used, so a code is never accepted twice.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';

export const TOTP_STEP_SECONDS = 30;
export const TOTP_DIGITS = 6;
/** RFC 4226 §4 asks for at least 128 bits; 160 is the HMAC-SHA-1 block the apps expect. */
const SECRET_BYTES = 20;
const BASE32 = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ234567';

export function newTotpSecret(): Buffer {
  return randomBytes(SECRET_BYTES);
}

/** RFC 4648 base32 without padding: the form `otpauth://` URIs and typed keys use. */
export function base32(bytes: Buffer): string {
  let bits = 0;
  let value = 0;
  let out = '';
  for (const byte of bytes) {
    value = (value << 8) | byte;
    bits += 8;
    while (bits >= 5) {
      out += BASE32[(value >>> (bits - 5)) & 31];
      bits -= 5;
    }
  }
  if (bits > 0) out += BASE32[(value << (5 - bits)) & 31];
  return out;
}

/** `otpauth://totp/<label>?secret=…&issuer=…`; the label is `<issuer> (<host>):<email>` (plan ruling 7). */
export function otpauthUri(input: {
  readonly secret: Buffer;
  readonly label: string;
  readonly issuer: string;
}): string {
  const query = new URLSearchParams({
    secret: base32(input.secret),
    issuer: input.issuer,
    algorithm: 'SHA1',
    digits: String(TOTP_DIGITS),
    period: String(TOTP_STEP_SECONDS),
  });
  return `otpauth://totp/${encodeURIComponent(input.label)}?${query.toString()}`;
}

/** The code for `step` (RFC 4226 dynamic truncation over the step as a big-endian 64-bit counter). */
export function totpAt(secret: Buffer, step: number, digits: number = TOTP_DIGITS): string {
  const counter = Buffer.alloc(8);
  counter.writeBigUInt64BE(BigInt(step));
  const mac = createHmac('sha1', secret).update(counter).digest();
  const offset = mac[mac.length - 1]! & 0x0f;
  const binary = (mac.readUInt32BE(offset) & 0x7fffffff) % 10 ** digits;
  return String(binary).padStart(digits, '0');
}

export const stepAt = (nowMs: number): number => Math.floor(nowMs / 1000 / TOTP_STEP_SECONDS);

export type TotpVerdict = { readonly ok: true; readonly step: number } | { readonly ok: false };

/**
 * Whether `code` is this secret's for the step at `nowMs` or one either side, and that step is after `lastStep`.
 * Every candidate is compared, in constant time, so the answer's timing does not say which step matched.
 */
export function verifyTotp(secret: Buffer, code: string, nowMs: number, lastStep: number): TotpVerdict {
  const typed = code.replace(/\s/g, '');
  if (!/^\d{6}$/.test(typed)) return { ok: false };
  const now = stepAt(nowMs);
  let matched: number | undefined;
  for (const step of [now - 1, now, now + 1]) {
    const same = timingSafeEqual(Buffer.from(totpAt(secret, step)), Buffer.from(typed));
    if (same && step > lastStep && matched === undefined) matched = step;
  }
  return matched === undefined ? { ok: false } : { ok: true, step: matched };
}
