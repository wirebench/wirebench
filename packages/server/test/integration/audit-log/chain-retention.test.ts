/**
 * Retention with a chain key (issue #210, audit-chain spec §3.3) against Postgres: only sealed rows go,
 * from the chain's oldest end, and the anchor moves to the last deleted row in the same transaction, so
 * the kept chain still verifies. Links are recomputed with `canonical.ts` after every deletion.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, expect, it, vi } from 'vitest';
import { anchorMac, keyId, link } from '../../../src/audit-log/chain/canonical.js';
import { AUDIT_CHAIN_LOCK_CLASS, tryLockChain } from '../../../src/audit-log/chain/lock.js';
import { RetentionStopLog } from '../../../src/audit-log/chain/retention-log.js';
import { AuditSealer, type SealPass } from '../../../src/audit-log/chain/sealer.js';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import {
  claimUnsealed,
  deleteSealedBefore,
  deleteUnsealedBefore,
  insertGenesis,
  readAnchor,
  sealedPage,
  sealRows,
  setAnchorHead,
} from '../../../src/audit-log/repo.js';
import type { Database, Querier } from '../../../src/context.js';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../../../src/db/migrate.js';
import { SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { manualTimers } from '../../helpers/timers.js';

const dir = (name: string) => fileURLToPath(new URL(`../../../migrations/${name}/`, import.meta.url));
const KEY = 'test-chain-key-0123456789abcdefghij';

const silentLog = (() => {
  const noop = () => undefined;
  const logger = {
    level: 'info',
    fatal: noop,
    error: noop,
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: (): unknown => logger,
  };
  return logger as unknown as FastifyBaseLogger;
})();

/** A logger that keeps its `error` lines, for retention's stop log. */
function errorLog() {
  const errors: unknown[][] = [];
  const noop = () => undefined;
  const logger = {
    level: 'info',
    fatal: noop,
    error: (...args: unknown[]) => {
      errors.push(args);
    },
    warn: noop,
    info: noop,
    debug: noop,
    trace: noop,
    silent: noop,
    child: (): unknown => logger,
  };
  return { errors, log: logger as unknown as FastifyBaseLogger };
}
const stopLine = (seq: number) => [
  { seq: String(seq) },
  `audit chain retention stopped at seq ${String(seq)}: run wirebench-server admin audit verify`,
];

/** `2026-10-03T00:00:<n>Z`: row times in whole seconds. */
const t = (n: number) => `2026-10-03T00:00:${String(n).padStart(2, '0')}Z`;
/** Half a second after `t(n)`: rows at `n` or earlier are past it, rows after `n` are not. */
const cutoff = (n: number) => new Date(Date.parse(t(n)) + 500);

/**
 * The database, with each transaction paused just after a statement matching `after` until `release`,
 * so a test holds a pass or a batch at a known point while it acts on other clients.
 */
function gated(db: Database, after: RegExp) {
  let release: () => void = () => undefined;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  let reached: () => void = () => undefined;
  const entered = new Promise<void>((resolve) => {
    reached = resolve;
  });
  const wrapped: Database = {
    query: db.query.bind(db),
    close: () => db.close(),
    transaction: (fn) =>
      db.transaction((tx) =>
        fn({
          query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
            const result = await tx.query<R>(text, params);
            if (after.test(text)) {
              reached();
              await gate;
            }
            return result;
          },
        }),
      ),
  };
  return { db: wrapped, entered, release: () => release() };
}

describeDb('retention with a chain key (audit-chain spec §3.3)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let ids = 0;
  /** Retention's stop log, fresh for each test; `errors` holds what it logged. */
  let stops: RetentionStopLog;
  let errors: unknown[][];
  /** Inserts a row with the given `at` and returns its id; ids sort in insert order. */
  const insert = async (at: string, q: Querier = db) => {
    ids += 1;
    const id = `01J9ZK3V8Q${String(ids).padStart(16, '0')}`;
    await q.query(
      `insert into audit_events (id, at, actor_kind, action, target_kind, details)
       values ($1, $2, 'system', 'team.created', 'team', '{}'::jsonb)`,
      [id, at],
    );
    return id;
  };
  const sealer = (extra: Partial<ConstructorParameters<typeof AuditSealer>[0]> = {}) =>
    new AuditSealer({
      db,
      key: KEY,
      now: () => new Date(),
      setTimer: manualTimers().setTimer,
      log: silentLog,
      ...extra,
    });
  /** Seals everything unsealed now, in one pass. */
  const seal = async () => (await sealer().runOnce()).sealed;
  /** Every row as `[id, seq]`, sealed rows in chain order and unsealed ones (seq null) after. */
  const rows = async () =>
    (
      await db.query<{ id: string; seq: string | null }>(
        'select id, chain_seq::text as seq from audit_events order by chain_seq nulls last, at, id',
      )
    ).rows.map((r) => [r.id, r.seq === null ? null : Number(r.seq)]);
  /** Every sealed row's hash by seq, read before a deletion. */
  const hashes = async () =>
    new Map(
      (
        await db.query<{ seq: string; hash: Buffer }>(
          'select chain_seq::text as seq, chain_hash as hash from audit_events where chain_seq is not null',
        )
      ).rows.map((r) => [BigInt(r.seq), r.hash]),
    );
  /** Recomputes every kept link from the anchor with canonical.ts and returns the seqs walked. */
  const walk = async (): Promise<number[]> => {
    const anchor = await readAnchor(db);
    expect(anchor).toBeDefined();
    let prev = { seq: anchor!.seq, hash: anchor!.hash };
    const seqs: number[] = [];
    for (const sealed of await sealedPage(db, anchor!.seq, 10_000)) {
      expect(sealed.seq).toBe(prev.seq + 1n);
      expect(sealed.hash).toEqual(link(KEY, prev.hash, sealed.seq, sealed.row));
      prev = { seq: sealed.seq, hash: sealed.hash };
      seqs.push(Number(sealed.seq));
    }
    return seqs;
  };

  beforeAll(async () => {
    db = await testDatabase();
    const modules = await Promise.all(
      ['identity', 'teams-access', 'audit-log'].map((name) => loadMigrations(dir(name), { contiguous: false })),
    );
    await migrate(
      db,
      [...(await loadMigrations(MIGRATIONS_DIR)), ...modules.flat()].sort((a, b) => a.version - b.version),
    );
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.query('delete from audit_events');
    await db.query('delete from audit_chain_anchor');
    const logged = errorLog();
    stops = new RetentionStopLog(logged.log);
    errors = logged.errors;
  });

  it('deletes the old sealed rows and moves the anchor to the last deleted row, keeping key id and head_seq', async () => {
    for (let n = 1; n <= 5; n++) await insert(t(n));
    expect(await seal()).toBe(5);
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(3), 1000, stops)).toBe(3);
    expect(await readAnchor(db)).toEqual({
      seq: 3n,
      hash: before.get(3n),
      keyId: keyId(KEY),
      headSeq: 5n,
      mac: anchorMac(KEY, 3n, before.get(3n)!, 5n),
    });
    expect((await rows()).map(([, seq]) => seq)).toEqual([4, 5]);
  });

  it('the kept rows recompute from the new anchor, and sealing links on from the kept head', async () => {
    for (let n = 1; n <= 6; n++) await insert(t(n));
    expect(await seal()).toBe(6);
    expect(await deleteSealedBefore(db, KEY, cutoff(4), 1000, stops)).toBe(4);
    expect(await walk()).toEqual([5, 6]);
    await insert(t(7));
    expect(await seal()).toBe(1);
    expect(await walk()).toEqual([5, 6, 7]);
  });

  it('an unsealed old row is not deleted; once sealed and past the cutoff it goes', async () => {
    await insert(t(1));
    await insert(t(2));
    expect(await seal()).toBe(2);
    const unsealed = await insert(t(1));
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(2);
    expect(await rows()).toEqual([[unsealed, null]]);
    expect(await seal()).toBe(1);
    expect(await rows()).toEqual([[unsealed, 3]]);
    expect(await walk()).toEqual([3]);
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(1);
    expect(await rows()).toEqual([]);
    expect(await readAnchor(db)).toMatchObject({ seq: 3n, headSeq: 3n });
  });

  it('late rows (old at, high seq) wait behind a younger row sealed before them, then go with it; no gap appears', async () => {
    // seq 1 at 1 s and seq 2 at 6 s; then rows committed late, with older times, seal at seqs 3 and 4.
    await insert(t(1));
    const recent = await insert(t(6));
    expect(await seal()).toBe(2);
    const lateA = await insert(t(2));
    const lateB = await insert(t(3));
    expect(await seal()).toBe(2);

    // Seqs 3 and 4 are past the cutoff, but seq 2 is not: only seq 1 goes.
    expect(await deleteSealedBefore(db, KEY, cutoff(4), 1000, stops)).toBe(1);
    expect(await rows()).toEqual([
      [recent, 2],
      [lateA, 3],
      [lateB, 4],
    ]);
    expect(await walk()).toEqual([2, 3, 4]);
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(0);

    // Once seq 2 passes the cutoff, it and the rows it held back go together.
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(6), 1000, stops)).toBe(3);
    expect(await rows()).toEqual([]);
    expect(await readAnchor(db)).toMatchObject({ seq: 4n, hash: before.get(4n), headSeq: 4n });
  });

  it('respects the batch limit across repeated calls, the anchor and the kept chain verifying after each', async () => {
    for (let n = 1; n <= 7; n++) await insert(t(n));
    await insert(t(30));
    expect(await seal()).toBe(8);
    const before = await hashes();
    const counts: number[] = [];
    for (;;) {
      const deleted = await deleteSealedBefore(db, KEY, cutoff(10), 3, stops);
      counts.push(deleted);
      if (deleted === 0) break;
      const anchor = await readAnchor(db);
      expect(anchor!.hash).toEqual(before.get(anchor!.seq));
      expect((await walk())[0]).toBe(Number(anchor!.seq) + 1);
    }
    expect(counts).toEqual([3, 3, 1, 0]);
    expect((await rows()).map(([, seq]) => seq)).toEqual([8]);
    expect(await readAnchor(db)).toMatchObject({ seq: 7n, hash: before.get(7n), headSeq: 8n });
  });

  it('deletes nothing and leaves the anchor while its MAC fails the check, or was made with another key', async () => {
    for (let n = 1; n <= 4; n++) await insert(t(n));
    expect(await seal()).toBe(4);
    await db.query('update audit_chain_anchor set head_seq = 9');
    const tampered = await readAnchor(db);
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(0);
    expect(await readAnchor(db)).toEqual(tampered);
    expect(await rows()).toHaveLength(4);
    await db.query('update audit_chain_anchor set head_seq = 4');
    expect(await deleteSealedBefore(db, 'another-chain-key-9876543210zyxwvuts', cutoff(10), 1000, stops)).toBe(0);
    expect(await rows()).toHaveLength(4);
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(4);
  });

  it('deletes nothing without an anchor, with nothing sealed, or with nothing sealed past the cutoff', async () => {
    await insert(t(1));
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(0);
    expect(await readAnchor(db)).toBeUndefined();
    expect(await rows()).toHaveLength(1);

    // An anchor, but no sealed row: the old row is unsealed.
    await insertGenesis(db, KEY);
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(0);
    expect(await rows()).toHaveLength(1);

    // Sealed, but younger than the cutoff.
    expect(await seal()).toBe(1);
    const anchor = await readAnchor(db);
    expect(await deleteSealedBefore(db, KEY, cutoff(0), 1000, stops)).toBe(0);
    expect(await readAnchor(db)).toEqual(anchor);
    expect(await rows()).toHaveLength(1);
  });

  it('after retention deletes every sealed row, the next pass seals at head_seq + 1, linked to the moved anchor', async () => {
    for (let n = 1; n <= 4; n++) await insert(t(n));
    expect(await seal()).toBe(4);
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(4);
    expect(await readAnchor(db)).toEqual({
      seq: 4n,
      hash: before.get(4n),
      keyId: keyId(KEY),
      headSeq: 4n,
      mac: anchorMac(KEY, 4n, before.get(4n)!, 4n),
    });
    const next = await insert(t(20));
    expect(await seal()).toBe(1);
    expect(await rows()).toEqual([[next, 5]]);
    const [row] = await sealedPage(db, 4n, 10);
    expect(row!.hash).toEqual(link(KEY, before.get(4n)!, 5n, row!.row));
    expect(await walk()).toEqual([5]);
  });

  it('a batch skips while a sealing pass holds the lock, deleting nothing; the next batch runs', async () => {
    for (let n = 1; n <= 3; n++) await insert(t(n));
    expect(await seal()).toBe(3);
    for (let n = 4; n <= 6; n++) await insert(t(n));
    const held = gated(db, /for update skip locked/);
    const pass = sealer({ db: held.db }).runOnce();
    await held.entered;
    // The pass holds the chain lock, keyed by this schema, mid-transaction.
    const granted = await db.query(
      `select 1 from pg_locks where locktype = 'advisory' and granted and objsubid = 2
         and classid::bigint = $1 and objid::bigint = hashtext(current_schema())::oid::bigint`,
      [AUDIT_CHAIN_LOCK_CLASS],
    );
    expect(granted.rows).toHaveLength(1);
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(0);
    expect((await rows()).map(([, seq]) => seq)).toEqual([1, 2, 3, null, null, null]);
    held.release();
    expect((await pass).sealed).toBe(3);
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(6);
    expect(await readAnchor(db)).toMatchObject({ seq: 6n, headSeq: 6n });
    await insert(t(20));
    expect(await seal()).toBe(1);
    expect(await walk()).toEqual([7]);
  });

  it('a pass finding a batch holding the lock ends busy-elsewhere; the next pass links to the moved anchor', async () => {
    for (let n = 1; n <= 3; n++) await insert(t(n));
    expect(await seal()).toBe(3);
    await insert(t(4));
    const held = gated(db, /pg_try_advisory_xact_lock/);
    const batch = deleteSealedBefore(held.db, KEY, cutoff(2), 1000, stops);
    await held.entered;
    expect(await sealer().runOnce()).toMatchObject({ outcome: 'busy-elsewhere', sealed: 0 });
    held.release();
    expect(await batch).toBe(2);
    expect(await seal()).toBe(1);
    expect((await rows()).map(([, seq]) => seq)).toEqual([3, 4]);
    expect(await walk()).toEqual([3, 4]);
  });

  it('the lock is per schema: a pass holding it here does not hold it for another schema of the database', async () => {
    const other = await testDatabase();
    try {
      const held = gated(db, /pg_try_advisory_xact_lock/);
      const pass = sealer({ db: held.db }).runOnce();
      await held.entered;
      expect(await db.transaction((tx) => tryLockChain(tx))).toBe(false);
      expect(await other.transaction((tx) => tryLockChain(tx))).toBe(true);
      held.release();
      await pass;
    } finally {
      await other.close();
    }
  });

  it('sealer passes and retention batches racing on separate clients leave a gapless, verifying chain', async () => {
    // Sealing goes in (at, id) order, so the 18 rows at 0 to 5 s take seqs 1 to 18 and those at 6 to 9 s the rest.
    for (let n = 1; n <= 30; n++) await insert(t(n % 10));
    const s = sealer({ batchSize: 4 });
    const outcomes: SealPass['outcome'][] = [];
    for (let round = 0; round < 20; round++) {
      const [pass] = await Promise.all([s.runOnce(), deleteSealedBefore(db, KEY, cutoff(5), 3, stops)]);
      outcomes.push(pass.outcome);
    }
    expect(outcomes).not.toContain('failed');
    // Then a closing pass and sweep, one at a time, settle whatever the race left.
    while ((await seal()) > 0);
    while ((await deleteSealedBefore(db, KEY, cutoff(5), 3, stops)) > 0);
    expect(await readAnchor(db)).toMatchObject({ seq: 18n, headSeq: 30n });
    expect(await walk()).toEqual(Array.from({ length: 12 }, (_, i) => i + 19));
    expect((await rows()).every(([, seq]) => seq !== null)).toBe(true);
  });

  it('keeps a row whose at equals the cutoff exactly', async () => {
    await insert(t(1));
    const atCutoff = await insert(t(2));
    expect(await seal()).toBe(2);
    expect(await deleteSealedBefore(db, KEY, new Date(t(2)), 1000, stops)).toBe(1);
    expect(await rows()).toEqual([[atCutoff, 2]]);
  });

  it('stops at a gap: seqs missing past the anchor are never stepped over, and one error is logged', async () => {
    for (let n = 1; n <= 10; n++) await insert(t(n));
    await insert(t(30));
    expect(await seal()).toBe(11);
    // Seqs 1 to 7 deleted from outside: a gap wider than the batch limit of 3, right at the anchor.
    await db.query('delete from audit_events where chain_seq <= 7');
    const anchor = await readAnchor(db);
    expect(await deleteSealedBefore(db, KEY, cutoff(20), 3, stops)).toBe(0);
    expect(await deleteSealedBefore(db, KEY, cutoff(20), 3, stops)).toBe(0);
    expect(await readAnchor(db)).toEqual(anchor);
    expect((await rows()).map(([, seq]) => seq)).toEqual([8, 9, 10, 11]);
    // Once per distinct seq, however many sweeps hit it.
    expect(errors).toEqual([stopLine(1)]);
    expect(await verifyChain(db, KEY)).toMatchObject({ result: 'broken', broken: { seq: 1n, reason: 'missing' } });
  });

  it('a gap above old rows ends the prefix there: the rows before it go, nothing after it', async () => {
    for (let n = 1; n <= 5; n++) await insert(t(n));
    expect(await seal()).toBe(5);
    await db.query('delete from audit_events where chain_seq = 3');
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(2);
    expect(await readAnchor(db)).toMatchObject({ seq: 2n, hash: before.get(2n) });
    expect((await rows()).map(([, seq]) => seq)).toEqual([4, 5]);
    expect(errors).toEqual([stopLine(3)]);
    expect(await verifyChain(db, KEY)).toMatchObject({ result: 'broken', broken: { seq: 3n, reason: 'missing' } });
  });

  it('a young row deleted from outside just above old rows leaves its gap visible above the anchor', async () => {
    for (let n = 1; n <= 3; n++) await insert(t(n));
    await insert(t(8));
    await insert(t(9));
    expect(await seal()).toBe(5);
    await db.query('delete from audit_events where chain_seq = 4');
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(3);
    // The anchor stops at the last old row, below the gap, so a walk still finds seq 4 missing.
    expect(await readAnchor(db)).toMatchObject({ seq: 3n, hash: before.get(3n) });
    expect((await sealedPage(db, 3n, 10)).map((row) => row.seq)).toEqual([5n]);
    expect(errors).toEqual([stopLine(4)]);
  });

  it('recent rows backdated from outside are not deleted: their links fail, and verify reports edited', async () => {
    for (let n = 1; n <= 3; n++) await insert(t(n));
    await insert(t(8));
    await insert(t(9));
    expect(await seal()).toBe(5);
    await db.query(`update audit_events set at = '2000-01-01T00:00:00Z' where chain_seq >= 4`);
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(3);
    // The anchor stops at the last genuine old row; it is never re-signed past the edited ones.
    expect(await readAnchor(db)).toMatchObject({ seq: 3n, hash: before.get(3n), headSeq: 5n });
    expect((await rows()).map(([, seq]) => seq)).toEqual([4, 5]);
    expect(errors).toEqual([stopLine(4)]);
    expect(await deleteSealedBefore(db, KEY, cutoff(5), 1000, stops)).toBe(0);
    expect(errors).toHaveLength(1);
    expect(await verifyChain(db, KEY)).toMatchObject({ result: 'broken', broken: { seq: 4n, reason: 'edited' } });
  });

  it('an old row edited in place stops retention at that row', async () => {
    for (let n = 1; n <= 5; n++) await insert(t(n));
    expect(await seal()).toBe(5);
    await db.query(`update audit_events set details = '{"edited":true}'::jsonb where chain_seq = 3`);
    const before = await hashes();
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(2);
    expect(await readAnchor(db)).toMatchObject({ seq: 2n, hash: before.get(2n) });
    expect((await rows()).map(([, seq]) => seq)).toEqual([3, 4, 5]);
    expect(errors).toEqual([stopLine(3)]);
    expect(await verifyChain(db, KEY)).toMatchObject({ result: 'broken', broken: { seq: 3n, reason: 'edited' } });
  });

  it('ends the prefix before a row whose forward-queue entry another transaction holds, without waiting', async () => {
    for (let n = 1; n <= 5; n++) await insert(t(n));
    expect(await seal()).toBe(5);
    const queued = (await rows()).map(([id]) => id as string);
    // Seqs 2 and 4 are queued; the forwarder holds seq 4's entry mid-send.
    for (const id of [queued[1]!, queued[3]!]) {
      await db.query('insert into audit_forward_queue (event_id) values ($1)', [id]);
    }
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let holding: () => void = () => undefined;
    const held = new Promise<void>((resolve) => {
      holding = resolve;
    });
    const forwarder = db.transaction(async (tx) => {
      await tx.query('select 1 from audit_forward_queue where event_id = $1 for update', [queued[3]]);
      holding();
      await gate;
    });
    await held;
    try {
      expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(3);
    } finally {
      release();
      await forwarder;
    }
    expect((await rows()).map(([, seq]) => seq)).toEqual([4, 5]);
    expect(await readAnchor(db)).toMatchObject({ seq: 3n });
    // Seq 2's queue entry went with its event; seq 4's stays.
    const left = await db.query<{ id: string }>('select event_id as id from audit_forward_queue');
    expect(left.rows).toEqual([{ id: queued[3] }]);
    expect(errors).toEqual([]);
    // Once the forwarder lets go, the rest goes.
    expect(await deleteSealedBefore(db, KEY, cutoff(10), 1000, stops)).toBe(2);
  });

  it('without the key, deleteUnsealedBefore keeps every sealed row and deletes old unsealed ones', async () => {
    await insert(t(1));
    await insert(t(2));
    expect(await seal()).toBe(2);
    const unsealedOld = await insert(t(1));
    const unsealedYoung = await insert(t(9));
    expect(await deleteUnsealedBefore(db, cutoff(5), 1000)).toBe(1);
    const left = (await rows()).map(([id]) => id);
    expect(left).not.toContain(unsealedOld);
    expect(left).toContain(unsealedYoung);
    expect((await rows()).map(([, seq]) => seq)).toEqual([1, 2, null]);
    expect(await verifyChain(db, KEY)).toMatchObject({ result: 'intact', checked: 2 });
  });
});

describeDb('retention with a chain key in a running server (audit-chain spec §3.3)', () => {
  const keys = testKeys();
  const WAIT = { timeout: 5_000, interval: 20 };
  const cleanup: (() => Promise<void>)[] = [];
  afterEach(async () => {
    for (const step of cleanup.splice(0).reverse()) await step();
  });

  async function server(env: Record<string, string>) {
    const timers = manualTimers();
    const h = await licensingHarness(keys, {
      env,
      extra: (clock) => [auditLogModule({ now: () => clock.now, setTimer: timers.setTimer })],
    });
    cleanup.push(() => h.close());
    return { h, timers };
  }
  /** A row far past the default retention of 365 days on the harness clock. */
  const insertOld = (db: Querier, id: string) =>
    db.query(
      `insert into audit_events (id, at, actor_kind, action, target_kind, details)
       values ($1, '2024-01-01T00:00:00Z', 'system', 'team.created', 'team', '{}'::jsonb)`,
      [id],
    );
  const idsOf = async (db: Querier) =>
    (await db.query<{ id: string }>('select id from audit_events order by id')).rows.map((r) => r.id);

  it('with the key, the sweep deletes the old sealed row, keeps the old unsealed one and moves the anchor', async () => {
    const { h, timers } = await server({ WIREBENCH_SERVER_AUDIT_CHAIN_KEY: KEY });
    await insertOld(h.db, '01J9ZK3V8Q0000000000000SE1');
    const outside = new AuditSealer({
      db: h.db,
      key: KEY,
      now: () => new Date(),
      setTimer: manualTimers().setTimer,
      log: silentLog,
    });
    // The module's own pass at start may hold the lock; pass until this row is sealed.
    await vi.waitFor(async () => {
      await outside.runOnce();
      const sealed = await h.db.query('select 1 from audit_events where chain_seq is not null');
      expect(sealed.rows).toHaveLength(1);
    }, WAIT);
    await insertOld(h.db, '01J9ZK3V8Q0000000000000UN1');
    timers.fire(SWEEP_INTERVAL_MS);
    await vi.waitFor(async () => {
      expect(await idsOf(h.db)).toEqual(['01J9ZK3V8Q0000000000000UN1']);
    }, WAIT);
    expect((await readAnchor(h.db))?.seq).toBe(1n);
  }, 30_000);

  it('without the key but with a chain, the sweep keeps the old sealed row and deletes the old unsealed one', async () => {
    const { h, timers } = await server({});
    // Sealed as an instance with the key would, in one transaction, so the sweep at start never sees
    // the row unsealed with an anchor present, nor sealed without one.
    await h.db.transaction(async (tx) => {
      const anchor = await insertGenesis(tx, KEY);
      await insertOld(tx, '01J9ZK3V8Q0000000000000SE3');
      const [row] = await claimUnsealed(tx, 1);
      await sealRows(tx, [{ id: row!.id!, seq: 1n, hash: link(KEY, anchor.hash, 1n, row!) }]);
      await setAnchorHead(tx, KEY, anchor, 1n);
    });
    await insertOld(h.db, '01J9ZK3V8Q0000000000000UN3');
    timers.fire(SWEEP_INTERVAL_MS);
    await vi.waitFor(async () => {
      expect(await idsOf(h.db)).toEqual(['01J9ZK3V8Q0000000000000SE3']);
    }, WAIT);
    expect(await readAnchor(h.db)).toMatchObject({ seq: 0n, headSeq: 1n });
    expect(await verifyChain(h.db, KEY)).toMatchObject({ result: 'intact', checked: 1 });
  }, 30_000);

  it('without the key, the sweep deletes old rows by at, unsealed or not', async () => {
    const { h, timers } = await server({});
    await insertOld(h.db, '01J9ZK3V8Q0000000000000UN2');
    timers.fire(SWEEP_INTERVAL_MS);
    await vi.waitFor(async () => {
      expect(await idsOf(h.db)).toEqual([]);
    }, WAIT);
  }, 30_000);
});
