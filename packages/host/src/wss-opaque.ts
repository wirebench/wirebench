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

function keysOf(value: unknown): string[] {
  return typeof value === 'object' && value !== null && !Array.isArray(value) ? Object.keys(value) : [];
}

/**
 * True when the stored entry has a key (on the entry, or on one of its parts) that its wire mirror
 * does not emit. Writing the mirror back would drop that key, so the entry must stay opaque. The
 * mirror itself is the source of truth for what is editable; no list of fields is kept here.
 */
export function hasUnmirroredFields(stored: unknown, wire: unknown): boolean {
  const wireKeys = new Set(keysOf(wire));
  if (keysOf(stored).some((key) => !wireKeys.has(key))) {
    return true;
  }
  const storedParts = (stored as Record<string, unknown> | null)?.['parts'];
  const wireParts = (wire as Record<string, unknown> | null)?.['parts'];
  if (!Array.isArray(storedParts)) {
    return false;
  }
  return storedParts.some((part: unknown, i) => {
    const emitted = new Set(keysOf(Array.isArray(wireParts) ? wireParts[i] : undefined));
    return keysOf(part).some((key) => !emitted.has(key));
  });
}
