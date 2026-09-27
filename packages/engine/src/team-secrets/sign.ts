/**
 * Signatures over team-secrets files (§4): Ed25519 over the canonical JSON (keys sorted at every depth, no
 * whitespace, `undefined` dropped) of the document without its `signature` field. YAML formatting, key
 * order in the file and line endings therefore never change what was signed.
 */
import { sign, verify } from 'node:crypto';
import { base64url, fromBase64url, signingPrivateKey, signingPublicKey, type MachineKeys } from './keys.js';
import { teamSecretsError } from './errors.js';

export type Signed<T> = T & { readonly signature: string };

/**
 * Canonical JSON of `value`: object keys sorted at every depth, no whitespace, `undefined` values (object
 * fields only, never array elements) dropped. Only JSON's own shapes are accepted — `null`, booleans,
 * strings, finite numbers, arrays, and plain objects (prototype `Object.prototype` or `null`) — so a
 * `Date`, `Map`, `Set`, class instance, function, symbol, `NaN` or `±Infinity` throws rather than silently
 * signing something that would not round-trip through YAML the same way twice. `-0` is written as `0`
 * (`JSON.stringify` already does this, and YAML has no distinct negative zero), which is deliberate, not
 * an oversight.
 *
 * @throws WirebenchError `team-secrets-not-canonical`
 */
export function canonicalJson(value: unknown): string {
  if (value === null) {
    return 'null';
  }
  if (typeof value === 'boolean' || typeof value === 'string') {
    return JSON.stringify(value);
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) {
      throw teamSecretsError('team-secrets-not-canonical', { reason: 'non-finite number' });
    }
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  if (typeof value === 'object') {
    const prototype: unknown = Object.getPrototypeOf(value);
    if (prototype !== Object.prototype && prototype !== null) {
      throw teamSecretsError('team-secrets-not-canonical', { reason: 'not a plain object' });
    }
    const entries = Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
    return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
  }
  // undefined, function, symbol, bigint — none of them are a JSON value.
  throw teamSecretsError('team-secrets-not-canonical', { reason: `unsupported type ${typeof value}` });
}

/** A shallow copy of `doc` without its `signature` field. */
export function withoutSignature(doc: object): Record<string, unknown> {
  const copy: Record<string, unknown> = { ...(doc as Record<string, unknown>) };
  delete copy['signature'];
  return copy;
}

function signedBytes(doc: object): Buffer {
  return Buffer.from(canonicalJson(withoutSignature(doc)), 'utf8');
}

/** `doc` with a fresh `signature` by `keys`; an existing signature is replaced. */
export function signDocument<T extends object>(doc: T, keys: MachineKeys): Signed<T> {
  const signature = base64url(sign(null, signedBytes(doc), signingPrivateKey(keys)));
  return { ...(withoutSignature(doc) as T), signature };
}

/** Whether `doc.signature` is `signingKey`'s signature over the rest of `doc`. Never throws. */
export function verifyDocument<T extends { readonly signature: string }>(doc: T, signingKey: string): boolean {
  try {
    return verify(null, signedBytes(doc), signingPublicKey(signingKey), fromBase64url(doc.signature));
  } catch {
    return false;
  }
}
