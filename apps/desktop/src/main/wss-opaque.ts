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

const PART_KEYS: ReadonlySet<string> = new Set(['name', 'namespace', 'encode', 'token']);

/** The fields this build edits on each kind it rebuilds field by field; any other key is a newer build's. */
const EDITED_KEYS: Readonly<Record<string, { keys: ReadonlySet<string>; partKeys?: ReadonlySet<string> }>> = {
  timestamp: { keys: new Set(['kind', 'timeToLiveSeconds', 'millisecondPrecision']) },
  'username-token': {
    keys: new Set(['kind', 'username', 'passwordRef', 'passwordType', 'addNonce', 'addCreated']),
  },
  signature: {
    keys: new Set([
      'kind',
      'keystoreRef',
      'alias',
      'keyPasswordRef',
      'keyIdentifierType',
      'signatureAlgorithm',
      'digestAlgorithm',
      'canonicalization',
      'useSingleCertificate',
      'parts',
    ]),
    partKeys: PART_KEYS,
  },
  encryption: {
    keys: new Set([
      'kind',
      'keystoreRef',
      'alias',
      'keyIdentifierType',
      'symmetricAlgorithm',
      'keyTransportAlgorithm',
      'embedKey',
      'encryptSymmetricKey',
      'parts',
    ]),
    partKeys: PART_KEYS,
  },
};

/**
 * True when a stored entry of a field-by-field kind carries a key this build does not edit, on the
 * entry or on one of its parts. Mirroring such an entry field by field would drop those keys on the
 * next write-back, so it is carried as an opaque entry instead.
 */
export function hasUnmirroredFields(stored: unknown): boolean {
  if (typeof stored !== 'object' || stored === null) {
    return false;
  }
  const record = stored as Record<string, unknown>;
  const kind = record['kind'];
  const spec = typeof kind === 'string' ? EDITED_KEYS[kind] : undefined;
  if (spec === undefined) {
    return false;
  }
  if (Object.keys(record).some((key) => !spec.keys.has(key))) {
    return true;
  }
  const parts = record['parts'];
  if (spec.partKeys !== undefined && Array.isArray(parts)) {
    const partKeys = spec.partKeys;
    return parts.some(
      (part: unknown) =>
        typeof part === 'object' && part !== null && Object.keys(part).some((key) => !partKeys.has(key)),
    );
  }
  return false;
}
