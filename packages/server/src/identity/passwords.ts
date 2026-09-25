/**
 * Password hashing (identity spec §3.4): scrypt from node:crypto, parameters stored beside the
 * hash so they can change later without a migration — a sign-in with an older set verifies and
 * then asks to be rehashed. Argon2 would need a native module; scrypt with these parameters is
 * the memory-hard choice the platform ships.
 */
import { randomBytes, scrypt as scryptCallback, timingSafeEqual, type ScryptOptions } from 'node:crypto';
import { promisify } from 'node:util';

const scrypt = promisify(
  (
    password: string,
    salt: Buffer,
    keylen: number,
    options: ScryptOptions,
    callback: (error: Error | null, derivedKey: Buffer) => void,
  ): void => scryptCallback(password, salt, keylen, options, callback),
);

export interface ScryptParams {
  readonly N: number;
  readonly r: number;
  readonly p: number;
  readonly keylen: number;
}

/** Changing these is an "ask first" item (spec §12). */
export const SCRYPT_PARAMS: ScryptParams = { N: 2 ** 15, r: 8, p: 1, keylen: 32 };
const SALT_BYTES = 16;
const PREFIX = 'scrypt';

/** scrypt needs 128·N·r bytes; this gives it 256·N·r, twice that, as headroom. */
const maxmem = (params: ScryptParams): number => 256 * params.N * params.r;

async function derive(password: string, salt: Buffer, params: ScryptParams): Promise<Buffer> {
  return await scrypt(password, salt, params.keylen, { N: params.N, r: params.r, p: params.p, maxmem: maxmem(params) });
}

export async function hashPassword(password: string, params: ScryptParams = SCRYPT_PARAMS): Promise<string> {
  const salt = randomBytes(SALT_BYTES);
  const hash = await derive(password, salt, params);
  return [PREFIX, params.N, params.r, params.p, salt.toString('base64'), hash.toString('base64')].join('$');
}

export function parseStoredHash(stored: string): { params: ScryptParams; salt: Buffer; hash: Buffer } | undefined {
  const parts = stored.split('$');
  if (parts.length !== 6 || parts[0] !== PREFIX) return undefined;
  const [N, r, p] = parts.slice(1, 4).map(Number) as [number, number, number];
  if (![N, r, p].every((n) => Number.isInteger(n) && n > 0)) return undefined;
  const salt = Buffer.from(parts[4]!, 'base64');
  const hash = Buffer.from(parts[5]!, 'base64');
  if (salt.length === 0 || hash.length === 0) return undefined;
  return { params: { N, r, p, keylen: hash.length }, salt, hash };
}

/** `rehash` is true when the password is right but was hashed with parameters older than {@link SCRYPT_PARAMS}. */
export async function verifyPassword(
  password: string,
  stored: string,
): Promise<{ readonly ok: boolean; readonly rehash: boolean }> {
  const parsed = parseStoredHash(stored);
  if (parsed === undefined) return { ok: false, rehash: false };
  let candidate: Buffer;
  try {
    candidate = await derive(password, parsed.salt, parsed.params);
  } catch {
    return { ok: false, rehash: false }; // parameters scrypt refuses (N not a power of two, too much memory)
  }
  const ok = candidate.length === parsed.hash.length && timingSafeEqual(candidate, parsed.hash);
  const current = parsed.params;
  const rehash =
    ok &&
    (current.N !== SCRYPT_PARAMS.N ||
      current.r !== SCRYPT_PARAMS.r ||
      current.p !== SCRYPT_PARAMS.p ||
      current.keylen !== SCRYPT_PARAMS.keylen);
  return { ok, rehash };
}
