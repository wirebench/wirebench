/**
 * Verify's walk over the audit chain (issue #210, audit-chain spec §3.4). It recomputes every sealed
 * row's link from the anchor and stops at the first broken one. The whole walk, the unsealed count and
 * the `--head` check read one `repeatable read, read only` snapshot: retention may move the anchor and
 * delete rows between two pages, and a walk across separate snapshots would then see a gap that is not
 * there. It takes no lock, so it never holds up sealing or retention.
 */
import type { Database, Querier } from '../../context.js';
import { readAnchor, sealedPage, type ChainLink, type SealedRow } from '../repo.js';
import { keyId, link } from './canonical.js';

/** Rows per page of the walk. */
export const VERIFY_PAGE = 1000;

/** Below every sequence number, so the walk also reads rows at or below the anchor (`out of order`). */
const BEFORE_ALL = -(2n ** 63n);

export type BrokenReason = 'edited' | 'missing' | 'out of order' | 'head not found' | 'head does not match';

export interface BrokenLink {
  readonly seq: bigint;
  /** The row at fault, when there is one: a `missing` seq has none. */
  readonly id?: string;
  readonly reason: BrokenReason;
}

export interface VerifySummary {
  readonly kind: 'checked';
  readonly result: 'intact' | 'broken';
  /** Sealed rows whose link verified, up to the first broken one. */
  readonly checked: number;
  /** The first and last of those rows' seqs; null when none verified. */
  readonly firstSeq: bigint | null;
  readonly lastSeq: bigint | null;
  /** Rows not sealed yet, in the same snapshot; never treated as broken. */
  readonly unsealed: number;
  readonly broken?: BrokenLink;
  /** With `--head` on an intact chain: the head is older than the kept chain, which retention moved past. */
  readonly headBeforeAnchor?: boolean;
}

export interface WrongKey {
  readonly kind: 'wrong-key';
  /** The anchor's key id; not secret. */
  readonly chainKeyId: string;
}

export interface VerifyOptions {
  /** A head from the server log: it must exist with exactly that hash. */
  readonly head?: { readonly seq: bigint; readonly hash: string };
  /** Tests only; production pages {@link VERIFY_PAGE} rows at a time. */
  readonly pageSize?: number;
}

/** The link a row should carry, or undefined when none can be built (an edited anchor or seq out of range). */
function expectedLink(key: string, prev: ChainLink, sealed: SealedRow): Buffer | undefined {
  try {
    return link(key, prev.hash, sealed.seq, sealed.row);
  } catch (error) {
    if (error instanceof RangeError) return undefined;
    throw error;
  }
}

const rowId = (sealed: SealedRow): { id?: string } => (sealed.row.id === null ? {} : { id: sealed.row.id });

export async function verifyChain(
  db: Database,
  key: string,
  options: VerifyOptions = {},
): Promise<VerifySummary | WrongKey> {
  const pageSize = options.pageSize ?? VERIFY_PAGE;
  return db.transaction(async (tx) => {
    await tx.query('set transaction isolation level repeatable read read only');
    const anchor = await readAnchor(tx);
    // Before any row is read: a wrong key would report every link as edited.
    if (anchor !== undefined && anchor.keyId !== keyId(key)) return { kind: 'wrong-key', chainKeyId: anchor.keyId };
    const unsealed = await countUnsealed(tx);

    let checked = 0;
    let firstSeq: bigint | null = null;
    let lastSeq: bigint | null = null;
    const summary = (broken?: BrokenLink, headBeforeAnchor = false): VerifySummary => ({
      kind: 'checked',
      result: broken === undefined ? 'intact' : 'broken',
      checked,
      firstSeq,
      lastSeq,
      unsealed,
      ...(broken !== undefined ? { broken } : {}),
      ...(headBeforeAnchor ? { headBeforeAnchor } : {}),
    });

    // The head's stored hash, once the walk has verified the row at its seq.
    let headHash: Buffer | undefined;
    if (anchor === undefined) {
      // No anchor: nothing sealed is an empty chain, but a sealed row without one means the anchor was removed.
      const [first] = await sealedPage(tx, BEFORE_ALL, 1);
      if (first !== undefined) return summary({ seq: first.seq, ...rowId(first), reason: 'edited' });
    } else {
      let prev: ChainLink = { seq: anchor.seq, hash: anchor.hash };
      if (options.head?.seq === anchor.seq) headHash = anchor.hash;
      for (let after = BEFORE_ALL; ;) {
        const page = await sealedPage(tx, after, pageSize);
        for (const sealed of page) {
          const next = prev.seq + 1n;
          if (sealed.seq > next) return summary({ seq: next, reason: 'missing' });
          if (sealed.seq < next) return summary({ seq: sealed.seq, ...rowId(sealed), reason: 'out of order' });
          const expected = expectedLink(key, prev, sealed);
          if (expected === undefined || !Buffer.isBuffer(sealed.hash) || !expected.equals(sealed.hash)) {
            return summary({ seq: sealed.seq, ...rowId(sealed), reason: 'edited' });
          }
          if (sealed.seq === options.head?.seq) headHash = sealed.hash;
          checked += 1;
          firstSeq ??= sealed.seq;
          lastSeq = sealed.seq;
          prev = { seq: sealed.seq, hash: sealed.hash };
        }
        const last = page.at(-1);
        if (last === undefined || page.length < pageSize) break;
        after = last.seq;
      }
    }

    // `--head` before `anchor.head_seq`: the operator asked about it, and its message names the cause.
    const head = options.head;
    const headBeforeAnchor = head !== undefined && anchor !== undefined && head.seq < anchor.seq;
    if (head !== undefined && !headBeforeAnchor) {
      if (headHash === undefined) return summary({ seq: head.seq, reason: 'head not found' });
      if (headHash.toString('hex') !== head.hash) return summary({ seq: head.seq, reason: 'head does not match' });
    }
    // The newest sealed rows, or all of them, were removed: the anchor remembers the highest seq sealed.
    const top = lastSeq ?? anchor?.seq ?? 0n;
    if (anchor !== undefined && top < anchor.headSeq) return summary({ seq: top + 1n, reason: 'missing' });
    return summary(undefined, headBeforeAnchor);
  });
}

async function countUnsealed(tx: Querier): Promise<number> {
  const row = (await tx.query<{ n: string }>('select count(*)::text as n from audit_events where chain_seq is null'))
    .rows[0];
  return Number(row?.n ?? 0);
}
