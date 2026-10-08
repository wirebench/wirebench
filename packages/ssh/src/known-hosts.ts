import { createHash } from 'node:crypto';

export interface KnownHostEntry {
  /** 'address:port' */
  readonly host: string;
  readonly keyType: string;
  /** 'SHA256:<base64, no padding>' */
  readonly fingerprint: string;
}

export type KnownHostCheck = 'known' | 'new' | 'changed';

export function fingerprintOf(key: Buffer): string {
  return `SHA256:${createHash('sha256').update(key).digest('base64').replace(/=+$/, '')}`;
}

/** The first SSH string in the wire-format public key is its type name. */
export function keyTypeOf(key: Buffer): string {
  const length = key.readUInt32BE(0);
  return key.subarray(4, 4 + length).toString('ascii');
}

const same = (a: KnownHostEntry, b: KnownHostEntry): boolean => a.host === b.host && a.keyType === b.keyType;

export function checkKnownHost(entries: readonly KnownHostEntry[], candidate: KnownHostEntry): KnownHostCheck {
  const found = entries.find((entry) => same(entry, candidate));
  if (!found) return 'new';
  return found.fingerprint === candidate.fingerprint ? 'known' : 'changed';
}

export function rememberKnownHost(
  entries: readonly KnownHostEntry[],
  entry: KnownHostEntry,
): readonly KnownHostEntry[] {
  return [...entries.filter((existing) => !same(existing, entry)), entry];
}

const isEntry = (value: unknown): value is KnownHostEntry =>
  typeof value === 'object' &&
  value !== null &&
  ['host', 'keyType', 'fingerprint'].every((key) => typeof (value as Record<string, unknown>)[key] === 'string');

/** A JSON array; an empty or broken file yields no entries. */
export function parseKnownHosts(text: string): readonly KnownHostEntry[] {
  try {
    const value: unknown = JSON.parse(text.trim() === '' ? '[]' : text);
    return Array.isArray(value) ? value.filter(isEntry) : [];
  } catch {
    return [];
  }
}

export function serializeKnownHosts(entries: readonly KnownHostEntry[]): string {
  return `${JSON.stringify(entries, null, 2)}\n`;
}
