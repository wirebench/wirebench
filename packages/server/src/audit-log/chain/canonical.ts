/**
 * The audit chain's link (audit-chain spec §2, §3.2): pure functions over the text Postgres renders for
 * a row, so the key stays in this process and never reaches the database. `CANONICAL_COLUMNS` in
 * `repo.ts` renders those texts for both the sealer and verify.
 */
import { createHash, createHmac, timingSafeEqual } from 'node:crypto';

/** One `audit_events` row as Postgres renders it for the chain; `null` where the column is null. */
export interface CanonicalRow {
  readonly id: string | null;
  /** `YYYY-MM-DDTHH:MM:SS.ffffffZ`, in UTC, to the microsecond. */
  readonly at: string | null;
  readonly actorKind: string | null;
  readonly actorUserId: string | null;
  readonly actorEmail: string | null;
  readonly actorTokenId: string | null;
  readonly actorWorkspaceId: string | null;
  readonly action: string | null;
  readonly targetKind: string | null;
  readonly targetId: string | null;
  readonly workspaceId: string | null;
  readonly teamId: string | null;
  /** `abbrev(ip)`: the netmask is covered; a single host prints without `/32` or `/128`. */
  readonly ip: string | null;
  readonly userAgent: string | null;
  /** `details::text`, which Postgres normalises (key order, whitespace). */
  readonly details: string | null;
}

/** The spec's column order; the canonical bytes follow it exactly. */
export const CANONICAL_FIELDS = [
  'id',
  'at',
  'actorKind',
  'actorUserId',
  'actorEmail',
  'actorTokenId',
  'actorWorkspaceId',
  'action',
  'targetKind',
  'targetId',
  'workspaceId',
  'teamId',
  'ip',
  'userAgent',
  'details',
] as const satisfies readonly (keyof CanonicalRow)[];

const GENESIS_MESSAGE = 'wirebench-audit-chain-genesis';
const ANCHOR_MESSAGE = 'wirebench-audit-chain-anchor';
const HASH_BYTES = 32;
const MAX_SEQ = 2n ** 63n - 1n;

/** A sequence number as 8 bytes, big-endian. */
const seqBytes = (seq: bigint): Buffer => {
  const bytes = Buffer.alloc(8);
  bytes.writeBigInt64BE(seq);
  return bytes;
};

/** The first 8 bytes of `SHA-256(key)`, in hex: tells a wrong key from a tampered chain. Not secret. */
export function keyId(key: string): string {
  return createHash('sha256').update(key, 'utf8').digest().subarray(0, 8).toString('hex');
}

/** The genesis anchor's hash, at sequence number 0. */
export function genesisHash(key: string): Buffer {
  return createHmac('sha256', key).update(GENESIS_MESSAGE, 'utf8').digest();
}

/** Each column as `len:value`, `len` in UTF-8 bytes; a null is `-1:`. */
export function canonicalBytes(row: CanonicalRow): Buffer {
  const parts: Buffer[] = [];
  for (const field of CANONICAL_FIELDS) {
    const value = row[field];
    if (value === null) {
      parts.push(Buffer.from('-1:', 'utf8'));
    } else {
      const bytes = Buffer.from(value, 'utf8');
      parts.push(Buffer.from(`${String(bytes.length)}:`, 'utf8'), bytes);
    }
  }
  return Buffer.concat(parts);
}

/** `HMAC-SHA256(key, prev_hash ‖ seq (8 bytes, big-endian) ‖ canonical(row))`. */
export function link(key: string, prevHash: Buffer, seq: bigint, row: CanonicalRow): Buffer {
  if (prevHash.length !== HASH_BYTES) throw new RangeError(`a previous hash is ${String(HASH_BYTES)} bytes`);
  if (seq < 1n || seq > MAX_SEQ) throw new RangeError('a sealed row has a sequence number from 1 to 2^63 - 1');
  return createHmac('sha256', key).update(prevHash).update(seqBytes(seq)).update(canonicalBytes(row)).digest();
}

/**
 * The anchor's MAC: `HMAC-SHA256(key, "wirebench-audit-chain-anchor" ‖ seq ‖ hash ‖ head_seq)`, each seq
 * as 8 bytes big-endian and the hash as its 32 raw bytes. Without the key nobody can move the anchor
 * forward (truncating the chain's oldest end), lower `head_seq` or edit the anchor's hash.
 */
export function anchorMac(key: string, seq: bigint, hash: Buffer, headSeq: bigint): Buffer {
  if (hash.length !== HASH_BYTES) throw new RangeError(`an anchor hash is ${String(HASH_BYTES)} bytes`);
  if (seq < 0n || seq > MAX_SEQ || headSeq < 0n || headSeq > MAX_SEQ) {
    throw new RangeError("an anchor's sequence numbers are from 0 to 2^63 - 1");
  }
  return createHmac('sha256', key)
    .update(ANCHOR_MESSAGE, 'utf8')
    .update(seqBytes(seq))
    .update(hash)
    .update(seqBytes(headSeq))
    .digest();
}

/** True when the anchor's stored MAC is this key's MAC of its fields; false for any edited or malformed field. */
export function anchorMacValid(
  key: string,
  anchor: { readonly seq: bigint; readonly hash: Buffer; readonly headSeq: bigint; readonly mac: Buffer },
): boolean {
  let expected: Buffer;
  try {
    expected = anchorMac(key, anchor.seq, anchor.hash, anchor.headSeq);
  } catch (error) {
    if (error instanceof RangeError) return false;
    throw error;
  }
  return Buffer.isBuffer(anchor.mac) && anchor.mac.length === expected.length && timingSafeEqual(anchor.mac, expected);
}
