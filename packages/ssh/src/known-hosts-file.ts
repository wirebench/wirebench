import { createHmac, timingSafeEqual } from 'node:crypto';
import { fingerprintOf, keyTypeOf, type KnownHostEntry } from './known-hosts.js';

/**
 * Reads an OpenSSH `known_hosts` file into keys for the trusted-keys store (`KnownHostEntry`). Only the hosts
 * the caller names gain a key: a hashed name can only be matched against a name anyway, and the store holds
 * keys for hosts Wirebench connects to, not a copy of every machine the user once reached.
 */

/** One key line: `[@marker] hosts keytype base64 [comment]`. */
export interface KnownHostsFileEntry {
  /** 1-based. */
  readonly line: number;
  readonly marker?: 'cert-authority' | 'revoked';
  /** The comma list of names, patterns or one `|1|salt|hash`. */
  readonly hosts: string;
  readonly keyType: string;
  readonly fingerprint: string;
}

export interface LexedKnownHostsFile {
  readonly entries: readonly KnownHostsFileEntry[];
  /** Lines that are neither a comment nor a key Wirebench can read. */
  readonly unreadable: readonly number[];
}

/** A host to match: its dialled address and port, and the names it has in `hosts.yaml`. */
export interface KnownHostsTarget {
  readonly address: string;
  readonly port: number;
  readonly names: readonly string[];
}

export interface KnownHostsFileRow extends KnownHostEntry {
  /** The `hosts.yaml` names of every host at this address and port. */
  readonly names: readonly string[];
  /** The known_hosts line the key came from. */
  readonly line: number;
}

export interface KnownHostsFileConflict extends KnownHostsFileRow {
  /** The fingerprint the store holds for this host and key type now. */
  readonly previous: string;
}

export type KnownHostsSkipReason = 'cert-authority' | 'revoked' | 'no-host' | 'duplicate' | 'unreadable';

export interface KnownHostsFilePlan {
  /** Keys for hosts and key types the store has none for. */
  readonly add: readonly KnownHostsFileRow[];
  /** Keys that differ from one the store holds: replaced only when chosen. */
  readonly conflicts: readonly KnownHostsFileConflict[];
  /** Keys the store already holds. */
  readonly trusted: readonly KnownHostsFileRow[];
  readonly skipped: readonly { readonly line: number; readonly reason: KnownHostsSkipReason }[];
}

const MARKERS = { '@cert-authority': 'cert-authority', '@revoked': 'revoked' } as const;
const BASE64 = /^[A-Za-z0-9+/]+={0,2}$/;

/** The name OpenSSH looks a host up by: the bare name on port 22, `[name]:port` on any other. */
export function knownHostsNameFor(address: string, port: number): string {
  const name = address.toLowerCase();
  return port === 22 ? name : `[${name}]:${port}`;
}

/**
 * Whether `name` matches a pattern where `*` is any run of characters and `?` any one, as OpenSSH's
 * `match_pattern` does: greedy with one backtrack point (at most pattern × name steps). No pattern becomes a RegExp.
 */
function globMatches(pattern: string, name: string): boolean {
  let p = 0;
  let n = 0;
  let star = -1;
  let resume = 0;
  while (n < name.length) {
    if (p < pattern.length && (pattern[p] === '?' || pattern[p] === name[n])) {
      p += 1;
      n += 1;
    } else if (p < pattern.length && pattern[p] === '*') {
      star = p;
      resume = n;
      p += 1;
    } else if (star !== -1) {
      p = star + 1;
      resume += 1;
      n = resume;
    } else {
      return false;
    }
  }
  while (pattern[p] === '*') p += 1;
  return p === pattern.length;
}

function hashedMatches(field: string, name: string): boolean {
  const parts = field.split('|');
  if (parts.length !== 4 || parts[1] !== '1') return false;
  const [salt, hash] = [parts[2] ?? '', parts[3] ?? ''];
  if (!BASE64.test(salt) || !BASE64.test(hash)) return false;
  const expected = Buffer.from(hash, 'base64');
  const actual = createHmac('sha1', Buffer.from(salt, 'base64')).update(name).digest();
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Whether a known_hosts host field names `name` (from {@link knownHostsNameFor}): a hashed field by its
 * salted HMAC-SHA1, otherwise a comma list of patterns with `*` and `?`, where a matching `!pattern` wins.
 */
export function hostFieldMatches(field: string, name: string): boolean {
  if (field.startsWith('|')) return hashedMatches(field, name);
  let matched = false;
  for (const raw of field.toLowerCase().split(',')) {
    const negated = raw.startsWith('!');
    const pattern = negated ? raw.slice(1) : raw;
    if (pattern === '' || !globMatches(pattern, name)) continue;
    if (negated) return false;
    matched = true;
  }
  return matched;
}

/** The type name a wire-format key blob starts with; '' when the blob is too short to hold one. */
function blobTypeOf(blob: Buffer): string {
  if (blob.length < 4 || blob.readUInt32BE(0) > blob.length - 4) return '';
  return keyTypeOf(blob);
}

export function lexKnownHostsFile(text: string): LexedKnownHostsFile {
  const entries: KnownHostsFileEntry[] = [];
  const unreadable: number[] = [];
  text.split(/\r?\n/).forEach((raw, index) => {
    const line = index + 1;
    const trimmed = raw.trim();
    if (trimmed === '' || trimmed.startsWith('#')) return;
    const words = trimmed.split(/\s+/);
    const first = words[0] ?? '';
    const marker = first in MARKERS ? MARKERS[first as keyof typeof MARKERS] : undefined;
    const [hosts, keyType, base64] = marker === undefined ? words : words.slice(1);
    if (hosts === undefined || keyType === undefined || base64 === undefined || !BASE64.test(base64)) {
      unreadable.push(line);
      return;
    }
    const blob = Buffer.from(base64, 'base64');
    if (blobTypeOf(blob) !== keyType) {
      unreadable.push(line);
      return;
    }
    entries.push({ line, ...(marker ? { marker } : {}), hosts, keyType, fingerprint: fingerprintOf(blob) });
  });
  return { entries, unreadable };
}

interface Slot {
  readonly host: string;
  readonly name: string;
  readonly names: string[];
}

/** One slot per address and port; hosts that share one share its names. */
function slotsFor(targets: readonly KnownHostsTarget[]): Slot[] {
  const slots = new Map<string, Slot>();
  for (const target of targets) {
    const address = target.address.toLowerCase();
    const host = `${address}:${target.port}`;
    const slot = slots.get(host) ?? { host, name: knownHostsNameFor(address, target.port), names: [] };
    for (const name of target.names) if (!slot.names.includes(name)) slot.names.push(name);
    slots.set(host, slot);
  }
  return [...slots.values()];
}

/**
 * Which hosts gain which key. A host and key type take the first line that names them; a later line for the
 * same pair is a `duplicate`. Markers are never imported: `@cert-authority` trusts a signer rather than a
 * key, and `@revoked` is a distrust the store cannot hold.
 */
export function planKnownHostsFileImport(input: {
  readonly text: string;
  readonly targets: readonly KnownHostsTarget[];
  readonly trusted: readonly KnownHostEntry[];
}): KnownHostsFilePlan {
  const lexed = lexKnownHostsFile(input.text);
  const slots = slotsFor(input.targets);
  const taken = new Set<string>();
  const add: KnownHostsFileRow[] = [];
  const conflicts: KnownHostsFileConflict[] = [];
  const trusted: KnownHostsFileRow[] = [];
  const skipped: { line: number; reason: KnownHostsSkipReason }[] = lexed.unreadable.map((line) => ({
    line,
    reason: 'unreadable',
  }));

  for (const entry of lexed.entries) {
    if (entry.marker) {
      skipped.push({ line: entry.line, reason: entry.marker });
      continue;
    }
    const matching = slots.filter((slot) => hostFieldMatches(entry.hosts, slot.name));
    let used = false;
    for (const slot of matching) {
      const key = `${slot.host}\n${entry.keyType}`;
      if (taken.has(key)) continue;
      taken.add(key);
      used = true;
      const row: KnownHostsFileRow = {
        host: slot.host,
        keyType: entry.keyType,
        fingerprint: entry.fingerprint,
        names: [...slot.names],
        line: entry.line,
      };
      const stored = input.trusted.find((e) => e.host === slot.host && e.keyType === entry.keyType);
      if (!stored) add.push(row);
      else if (stored.fingerprint === entry.fingerprint) trusted.push(row);
      else conflicts.push({ ...row, previous: stored.fingerprint });
    }
    if (!used) skipped.push({ line: entry.line, reason: matching.length === 0 ? 'no-host' : 'duplicate' });
  }
  skipped.sort((a, b) => a.line - b.line);
  return { add, conflicts, trusted, skipped };
}

export interface KnownHostsFileApplied {
  readonly entries: readonly KnownHostEntry[];
  readonly added: number;
  readonly replaced: number;
  /** Stored keys left as they were because they were not chosen for replacing. */
  readonly kept: number;
}

/**
 * Writes the plan over the store as it is now (`current`, read again at apply time). A key the store holds
 * for a host and key type is replaced only when that pair is in `replace`, so a key trusted since the
 * preview is never overwritten without being chosen.
 */
export function applyKnownHostsFileImport(
  plan: KnownHostsFilePlan,
  replace: readonly { readonly host: string; readonly keyType: string }[],
  current: readonly KnownHostEntry[],
): KnownHostsFileApplied {
  const chosen = new Set(replace.map((r) => `${r.host}\n${r.keyType}`));
  const entries = [...current];
  let added = 0;
  let replaced = 0;
  let kept = 0;
  for (const row of [...plan.add, ...plan.conflicts]) {
    const entry: KnownHostEntry = { host: row.host, keyType: row.keyType, fingerprint: row.fingerprint };
    const index = entries.findIndex((e) => e.host === entry.host && e.keyType === entry.keyType);
    if (index === -1) {
      entries.push(entry);
      added += 1;
    } else if (entries[index]?.fingerprint === entry.fingerprint) {
      continue;
    } else if (chosen.has(`${entry.host}\n${entry.keyType}`)) {
      entries[index] = entry;
      replaced += 1;
    } else {
      kept += 1;
    }
  }
  return { entries, added, replaced, kept };
}
