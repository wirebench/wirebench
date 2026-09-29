/**
 * Signing and verifying webhooks (spec `2026-09-29-wirebench-webhook-signatures-design.md` §2): three
 * generic schemes over the exact body bytes. One implementation serves the sender (`sendRest`'s
 * `sign`) and the receiver (the server's verification on receipt), so each side proves the other.
 *
 * Pure over bytes: `node:crypto` supplies the HMAC, the constant-time compare and the random id.
 */
import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { z } from 'zod';
import { WirebenchError } from '../errors.js';

export type SignatureAlgorithm = 'sha1' | 'sha256' | 'sha512';

export type SignatureScheme =
  | {
      readonly kind: 'hmac';
      readonly algorithm: SignatureAlgorithm;
      readonly encoding: 'hex' | 'base64';
      /** e.g. `X-Signature`. */
      readonly header: string;
      /** e.g. `sha256=`; required on verify when set, and stripped before comparing. */
      readonly prefix?: string;
    }
  | { readonly kind: 'timestamped'; readonly header: string; readonly toleranceSec: number }
  | { readonly kind: 'standard'; readonly toleranceSec: number };

/** Why a verification failed, in the order the checks run. */
export const SIGNATURE_FAILURES = [
  'missing-header',
  'malformed-header',
  'mismatch',
  'stale-timestamp',
  'key-error',
] as const;
export type SignatureFailure = (typeof SIGNATURE_FAILURES)[number];

export type SignatureVerdict =
  { readonly verdict: 'verified' } | { readonly verdict: 'failed'; readonly reason: SignatureFailure };

/** Five minutes either way, as the Standard Webhooks specification suggests. */
export const DEFAULT_SIGNATURE_TOLERANCE_SEC = 300;

/** An HTTP field name: RFC 9110 §5.1's `token`. */
const HEADER_NAME = /^[!#$%&'*+.^_`|~0-9A-Za-z-]+$/;
const HEX = /^[0-9a-fA-F]+$/;
/** Canonical, padded base64 only: `Buffer.from(…, 'base64')` would silently skip anything else. */
const BASE64 = /^(?:[A-Za-z0-9+/]{4})*(?:[A-Za-z0-9+/]{2}==|[A-Za-z0-9+/]{3}=)?$/;

/** Whether `text` is non-empty, canonical, padded base64 (one definition, shared with the server's key config). */
export function isCanonicalBase64(text: string): boolean {
  return text.length > 0 && BASE64.test(text);
}
const UNIX_SECONDS = /^\d{1,15}$/;
const STANDARD_SECRET_PREFIX = 'whsec_';
const DIGEST_BYTES: Readonly<Record<SignatureAlgorithm, number>> = { sha1: 20, sha256: 32, sha512: 64 };

const headerName = z.string().min(1).max(100).regex(HEADER_NAME);
const tolerance = z.number().int().min(1).max(86_400).default(DEFAULT_SIGNATURE_TOLERANCE_SEC);

/**
 * A scheme as the server's API and the project files accept it. Not annotated as
 * `z.ZodType<SignatureScheme>`: its output has `prefix?: string | undefined`, which
 * `exactOptionalPropertyTypes` will not assign; {@link toSignatureScheme} closes that gap.
 */
export const signatureSchemeSchema = z.discriminatedUnion('kind', [
  z.object({
    kind: z.literal('hmac'),
    algorithm: z.enum(['sha1', 'sha256', 'sha512']),
    encoding: z.enum(['hex', 'base64']),
    header: headerName,
    prefix: z
      .string()
      .max(32)
      .regex(/^[\x21-\x7e]*$/)
      .optional(),
  }),
  z.object({ kind: z.literal('timestamped'), header: headerName, toleranceSec: tolerance }),
  z.object({ kind: z.literal('standard'), toleranceSec: tolerance }),
]);

/** A parsed scheme with an absent (or empty) prefix truly absent. */
export function toSignatureScheme(parsed: z.output<typeof signatureSchemeSchema>): SignatureScheme {
  if (parsed.kind !== 'hmac') return parsed;
  const { prefix, ...rest } = parsed;
  return prefix === undefined || prefix === '' ? rest : { ...rest, prefix };
}

const utf8 = (text: string): Buffer => Buffer.from(text, 'utf8');

function mac(algorithm: SignatureAlgorithm, key: string | Uint8Array, ...parts: Uint8Array[]): Buffer {
  const hmac = createHmac(algorithm, key);
  for (const part of parts) hmac.update(part);
  return hmac.digest();
}

/** The key bytes: base64 after `whsec_`, else the secret's own UTF-8. `undefined` for a bad base64. */
function standardKey(secret: string): Buffer | undefined {
  if (!secret.startsWith(STANDARD_SECRET_PREFIX)) return utf8(secret);
  const encoded = secret.slice(STANDARD_SECRET_PREFIX.length);
  return isCanonicalBase64(encoded) ? Buffer.from(encoded, 'base64') : undefined;
}

const unixSeconds = (now: Date): number => Math.floor(now.getTime() / 1000);

/**
 * The headers that sign `body`. Every value is computed over the exact bytes given, so the caller
 * signs what goes on the wire, after every expansion and encoding.
 *
 * @throws WirebenchError `webhook-signing-secret` for a `standard` secret whose `whsec_` tail is not base64
 */
export function signWebhook(
  scheme: SignatureScheme,
  secret: string,
  body: Uint8Array,
  options: { readonly now?: Date; readonly id?: string } = {},
): readonly (readonly [name: string, value: string])[] {
  const now = options.now ?? new Date();
  switch (scheme.kind) {
    case 'hmac':
      return [
        [scheme.header, `${scheme.prefix ?? ''}${mac(scheme.algorithm, secret, body).toString(scheme.encoding)}`],
      ];
    case 'timestamped': {
      const t = String(unixSeconds(now));
      return [[scheme.header, `t=${t},v1=${mac('sha256', secret, utf8(`${t}.`), body).toString('hex')}`]];
    }
    case 'standard': {
      const key = standardKey(secret);
      if (key === undefined) {
        throw new WirebenchError(
          'webhook-signing-secret',
          'The signing secret starts with whsec_ but the rest is not base64',
        );
      }
      const id = options.id ?? `msg_${randomBytes(16).toString('hex')}`;
      const t = String(unixSeconds(now));
      return [
        ['webhook-id', id],
        ['webhook-timestamp', t],
        ['webhook-signature', `v1,${mac('sha256', key, utf8(`${id}.${t}.`), body).toString('base64')}`],
      ];
    }
  }
}

const VERIFIED: SignatureVerdict = { verdict: 'verified' };
const failed = (reason: SignatureFailure): SignatureVerdict => ({ verdict: 'failed', reason });

/** The first header named `name`, any case, trimmed. */
function headerValue(headers: readonly (readonly [string, string])[], name: string): string | undefined {
  const lower = name.toLowerCase();
  return headers.find(([key]) => key.toLowerCase() === lower)?.[1].trim();
}

/** A received digest as bytes, or `undefined` unless it is `encoding` of exactly `bytes` bytes. */
function decodeDigest(text: string, encoding: 'hex' | 'base64', bytes: number): Buffer | undefined {
  const valid = encoding === 'hex' ? HEX.test(text) && text.length === bytes * 2 : isCanonicalBase64(text);
  if (!valid) return undefined;
  const decoded = Buffer.from(text, encoding);
  return decoded.length === bytes ? decoded : undefined;
}

const same = (a: Buffer, b: Buffer): boolean => a.length === b.length && timingSafeEqual(a, b);
const within = (t: number, now: Date, toleranceSec: number): boolean => Math.abs(unixSeconds(now) - t) <= toleranceSec;
const isDefined = <T>(value: T | undefined): value is T => value !== undefined;

function verifyHmac(
  scheme: Extract<SignatureScheme, { kind: 'hmac' }>,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
): SignatureVerdict {
  let value = headerValue(headers, scheme.header);
  if (value === undefined) return failed('missing-header');
  const prefix = scheme.prefix ?? '';
  if (prefix !== '') {
    if (!value.startsWith(prefix)) return failed('malformed-header');
    value = value.slice(prefix.length);
  }
  const received = decodeDigest(value, scheme.encoding, DIGEST_BYTES[scheme.algorithm]);
  if (received === undefined) return failed('malformed-header');
  return same(received, mac(scheme.algorithm, secret, body)) ? VERIFIED : failed('mismatch');
}

/** `t=<seconds>,v1=<hex>[,v1=…]`; unknown keys and parts without `=` are ignored. */
function parseTimestamped(value: string): { readonly t: string; readonly v1: readonly Buffer[] } | undefined {
  let t: string | undefined;
  const v1: Buffer[] = [];
  for (const part of value.split(',')) {
    const at = part.indexOf('=');
    if (at === -1) continue;
    const key = part.slice(0, at).trim();
    const text = part.slice(at + 1).trim();
    if (key === 't') {
      if (t !== undefined || !UNIX_SECONDS.test(text)) return undefined;
      t = text;
    } else if (key === 'v1') {
      const digest = decodeDigest(text, 'hex', 32);
      if (digest !== undefined) v1.push(digest);
    }
  }
  return t === undefined || v1.length === 0 ? undefined : { t, v1 };
}

function verifyTimestamped(
  scheme: Extract<SignatureScheme, { kind: 'timestamped' }>,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
  now: Date,
): SignatureVerdict {
  const value = headerValue(headers, scheme.header);
  if (value === undefined) return failed('missing-header');
  const parsed = parseTimestamped(value);
  if (parsed === undefined) return failed('malformed-header');
  if (!within(Number(parsed.t), now, scheme.toleranceSec)) return failed('stale-timestamp');
  // Signed over the timestamp exactly as sent, not re-formatted.
  const expected = mac('sha256', secret, utf8(`${parsed.t}.`), body);
  return parsed.v1.some((candidate) => same(candidate, expected)) ? VERIFIED : failed('mismatch');
}

function verifyStandard(
  scheme: Extract<SignatureScheme, { kind: 'standard' }>,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
  now: Date,
): SignatureVerdict {
  const id = headerValue(headers, 'webhook-id');
  const t = headerValue(headers, 'webhook-timestamp');
  const signature = headerValue(headers, 'webhook-signature');
  if (id === undefined || t === undefined || signature === undefined) return failed('missing-header');
  if (!UNIX_SECONDS.test(t)) return failed('malformed-header');
  const candidates = signature
    .split(/\s+/)
    .filter((entry) => entry.startsWith('v1,'))
    .map((entry) => decodeDigest(entry.slice(3), 'base64', 32))
    .filter(isDefined);
  if (candidates.length === 0) return failed('malformed-header');
  if (!within(Number(t), now, scheme.toleranceSec)) return failed('stale-timestamp');
  const key = standardKey(secret);
  if (key === undefined) return failed('key-error');
  const expected = mac('sha256', key, utf8(`${id}.${t}.`), body);
  return candidates.some((candidate) => same(candidate, expected)) ? VERIFIED : failed('mismatch');
}

/**
 * Whether `body` arrived correctly signed under `scheme` and `secret`. Checks run header present →
 * header parses → timestamp → digest. Never throws: anything unexpected is `failed: key-error`.
 */
export function verifyWebhook(
  scheme: SignatureScheme,
  secret: string,
  headers: readonly (readonly [string, string])[],
  body: Uint8Array,
  options: { readonly now?: Date } = {},
): SignatureVerdict {
  const now = options.now ?? new Date();
  try {
    switch (scheme.kind) {
      case 'hmac':
        return verifyHmac(scheme, secret, headers, body);
      case 'timestamped':
        return verifyTimestamped(scheme, secret, headers, body, now);
      case 'standard':
        return verifyStandard(scheme, secret, headers, body, now);
    }
  } catch {
    return failed('key-error');
  }
}
