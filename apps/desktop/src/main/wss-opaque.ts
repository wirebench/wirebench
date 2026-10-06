/**
 * Helpers for the opaque `unknown` WS-Security wire entry: an entry this build cannot edit,
 * mirrored to the renderer as a marker and restored from the stored document on write-back.
 */

import { createHash } from 'node:crypto';

/** The entry kinds this build can edit; a stored entry of any other kind is a newer build's. */
export const KNOWN_WSS_ENTRY_KINDS: ReadonlySet<string> = new Set([
  'timestamp',
  'username-token',
  'signature',
  'encryption',
  'issued-token',
  'saml-token',
]);

/** JSON with object keys sorted at every depth, so equal content always serialises the same. */
function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) {
    return `[${value.map(canonicalJson).join(',')}]`;
  }
  if (typeof value === 'object' && value !== null) {
    const record = value as Record<string, unknown>;
    return `{${Object.keys(record)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson(record[key])}`)
      .join(',')}}`;
  }
  return JSON.stringify(value) ?? 'null';
}

/**
 * A short content hash of a stored entry. It travels on the opaque wire entry so that write-back
 * can tell the entry the editor saw from a different one that now sits at the same index.
 */
export function opaqueEntryFingerprint(stored: unknown): string {
  return createHash('sha256').update(canonicalJson(stored)).digest('hex').slice(0, 16);
}
