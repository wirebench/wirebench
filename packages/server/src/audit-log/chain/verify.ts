/**
 * Verify's walk over the audit chain (issue #210, audit-chain spec §3.4). It recomputes every sealed
 * row's link from the anchor, after checking the anchor's own MAC, and stops at the first broken one. The whole walk, the unsealed count and
 * the `--head` check read one `repeatable read, read only` snapshot: retention may move the anchor and
 * delete rows between two pages, and a walk across separate snapshots would then see a gap that is not
 * there. It takes no lock, so it never holds up sealing or retention.
 *
 * It walks one tenant's chain, in a read-only snapshot unit of that tenant, with that tenant's key (`keys.ts`). The
 * walk itself ({@link walkChain}) reads through a {@link ChainReader}, so an export's rows verify the same way with
 * no database at all (hosted edition spec §22.9, §13 criterion 6).
 */
import type { TenantDb, TenantQuerier } from '../../tenancy/tenant-db.js';
import { readAnchor, sealedPage, type ChainAnchor, type ChainLink, type SealedRow } from '../repo.js';
import { anchorMacValid, keyId, link } from './canonical.js';

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
  /** The anchor itself fails its MAC check (`edited` at the anchor's seq): it was moved or edited. */
  readonly anchor?: true;
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

/**
 * What the walk reads: the anchor, the unsealed count and the sealed rows a page at a time, in chain order. A
 * database's are one snapshot ({@link verifyChain}); an export's are its file's ({@link verifyChainRows}).
 */
export interface ChainReader {
  anchor(): Promise<ChainAnchor | undefined>;
  unsealed(): Promise<number>;
  /** Sealed rows with a seq above `afterSeq`, in seq order, at most `limit`. */
  page(afterSeq: bigint, limit: number): Promise<SealedRow[]>;
}

/** The walk itself, over whatever `read` reads. */
export async function walkChain(
  read: ChainReader,
  key: string,
  options: VerifyOptions = {},
): Promise<VerifySummary | WrongKey> {
  const pageSize = options.pageSize ?? VERIFY_PAGE;
  const anchor = await read.anchor();
  // Before any row is read: a wrong key would report every link as edited.
  if (anchor !== undefined && anchor.keyId !== keyId(key)) return { kind: 'wrong-key', chainKeyId: anchor.keyId };
  const unsealed = await read.unsealed();

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
  // An anchor moved forward (the oldest rows cut off), with its head_seq lowered, or edited at all.
  if (anchor !== undefined && !anchorMacValid(key, anchor)) {
    return summary({ seq: anchor.seq, reason: 'edited', anchor: true });
  }

  let headHash: Buffer | undefined;
  if (anchor === undefined) {
    // No anchor: nothing sealed is an empty chain, but a sealed row without one means the anchor was removed.
    const [first] = await read.page(BEFORE_ALL, 1);
    if (first !== undefined) return summary({ seq: first.seq, ...rowId(first), reason: 'edited' });
  } else {
    let prev: ChainLink = { seq: anchor.seq, hash: anchor.hash };
    if (options.head?.seq === anchor.seq) headHash = anchor.hash;
    for (let after = BEFORE_ALL; ;) {
      const page = await read.page(after, pageSize);
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
}

export async function verifyChain(
  db: TenantDb,
  key: string,
  options: VerifyOptions = {},
): Promise<VerifySummary | WrongKey> {
  return db.transaction(
    (tx) =>
      walkChain(
        {
          anchor: () => readAnchor(tx),
          unsealed: () => countUnsealed(tx),
          page: (after, n) => sealedPage(tx, after, n),
        },
        key,
        options,
      ),
    { readOnlySnapshot: true },
  );
}

/**
 * The walk over rows held in memory (an export's `audit_events.ndjson`, spec §22.9), with no database: `sealed` in any
 * order, `unsealed` counted by the caller.
 */
export function verifyChainRows(
  chain: { readonly anchor: ChainAnchor | undefined; readonly sealed: readonly SealedRow[]; readonly unsealed: number },
  key: string,
  options: VerifyOptions = {},
): Promise<VerifySummary | WrongKey> {
  const sorted = [...chain.sealed].sort((a, b) => (a.seq < b.seq ? -1 : a.seq > b.seq ? 1 : 0));
  return walkChain(
    {
      anchor: () => Promise.resolve(chain.anchor),
      unsealed: () => Promise.resolve(chain.unsealed),
      page: (after, limit) => Promise.resolve(sorted.filter((row) => row.seq > after).slice(0, limit)),
    },
    key,
    options,
  );
}

async function countUnsealed(tx: TenantQuerier): Promise<number> {
  const row = (await tx.query<{ n: string }>('select count(*)::text as n from audit_events where chain_seq is null'))
    .rows[0];
  return Number(row?.n ?? 0);
}
