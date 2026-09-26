/**
 * Signatures over team-secrets files (§4): Ed25519 over the canonical JSON (keys sorted at every depth, no
 * whitespace, `undefined` dropped) of the document without its `signature` field. YAML formatting, key
 * order in the file and line endings therefore never change what was signed.
 */
import { sign, verify } from 'node:crypto';
import { base64url, fromBase64url, signingPrivateKey, signingPublicKey, type MachineKeys } from './keys.js';

export type Signed<T> = T & { readonly signature: string };

export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') {
    return JSON.stringify(value);
  }
  if (Array.isArray(value)) {
    return `[${value.map((item) => canonicalJson(item)).join(',')}]`;
  }
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`).join(',')}}`;
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
