/**
 * The audit chain's sealer (issue #210, audit-chain spec §3.2, §7) against Postgres, with injected
 * timers: claim order, gapless sequence numbers, links recomputed with `canonical.ts`, rows left open in
 * another transaction, two sealers on one database, a wrong key, the loop's delays, and a running server.
 */
import { fileURLToPath } from 'node:url';
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { genesisHash, keyId, link } from '../../../src/audit-log/chain/canonical.js';
import {
  AUDIT_CHAIN_LOCK_ID,
  AuditSealer,
  backoff,
  SEAL_BACKOFF_MAX_MS,
  SEAL_BATCH,
  SEAL_BUSY_MS,
  SEAL_IDLE_MS,
  type SealPass,
} from '../../../src/audit-log/chain/sealer.js';
import { auditHook } from '../../../src/audit-log/hook.js';
import { auditLogModule } from '../../../src/audit-log/module.js';
import { insertGenesis, readAnchor, sealedPage, type ChainLink } from '../../../src/audit-log/repo.js';
import type { AuditInput, Database, Querier } from '../../../src/context.js';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../../../src/db/migrate.js';
import { SWEEP_INTERVAL_MS } from '../../../src/hooks/sweep.js';
import { describeDb, oneChainTestFileAtATime, testDatabase } from '../../helpers/database.js';
import { signedInUser } from '../../helpers/identity.js';
import { licensingHarness, testKeys } from '../../helpers/licensing.js';
import { call } from '../../helpers/teams.js';
import { manualTimers, type ManualTimers } from '../../helpers/timers.js';

const dir = (name: string) => fileURLToPath(new URL(`../../../migrations/${name}/`, import.meta.url));
const KEY = 'test-chain-key-0123456789abcdefghij';
const OTHER_KEY = 'another-chain-key-0123456789abcdefgh';

function recordingLog() {
  const lines: { level: string; args: unknown[] }[] = [];
  const at =
    (level: string) =>
    (...args: unknown[]) => {
      lines.push({ level, args });
    };
  const logger = {
    level: 'info',
    fatal: at('fatal'),
    error: at('error'),
    warn: at('warn'),
    info: at('info'),
    debug: at('debug'),
    trace: at('trace'),
    silent: at('silent'),
    child: (): unknown => logger,
  };
  const of = (level: string) => lines.filter((line) => line.level === level);
  return { lines, of, log: logger as unknown as FastifyBaseLogger };
}

/**
 * The database, with each transaction paused just after a statement matching `after` until `release`:
 * holds a pass at a known point (its lock taken, or its rows claimed) while the test acts on other clients.
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

// Advisory locks are database-wide; the files that take the chain's lock must not run side by side.
oneChainTestFileAtATime();

describeDb('the audit chain sealer (audit-chain spec §3.2)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let tick = Date.parse('2026-10-03T00:00:00Z');
  const clock = () => new Date((tick += 1000));
  const record = auditHook(clock, { forward: false });
  const event = (n: number): AuditInput => ({
    actor: { kind: 'user', userId: 'U1', email: 'a@example.com' },
    ip: '203.0.113.7',
    action: 'team.created',
    target: { kind: 'team', id: `T${String(n)}` },
    teamId: 'TEAM1',
    details: { n },
  });
  const insert = (q: Querier, id: string, at: string) =>
    q.query(
      `insert into audit_events (id, at, actor_kind, action, target_kind, details)
       values ($1, $2, 'system', 'team.created', 'team', '{}'::jsonb)`,
      [id, at],
    );
  /** Every row as `[id, seq]`, sealed rows in chain order and unsealed ones (seq null) after. */
  const rows = async () =>
    (
      await db.query<{ id: string; seq: string | null }>(
        'select id, chain_seq::text as seq from audit_events order by chain_seq nulls last, at, id',
      )
    ).rows.map((r) => [r.id, r.seq === null ? null : Number(r.seq)]);
  /** Recomputes every link from the anchor with canonical.ts and returns the seqs walked. */
  const walk = async (key = KEY): Promise<number[]> => {
    const anchor = await readAnchor(db);
    expect(anchor).toBeDefined();
    let prev = { seq: anchor!.seq, hash: anchor!.hash };
    const seqs: number[] = [];
    for (const sealed of await sealedPage(db, anchor!.seq, 10_000)) {
      expect(sealed.seq).toBe(prev.seq + 1n);
      expect(sealed.hash).toEqual(link(key, prev.hash, sealed.seq, sealed.row));
      prev = { seq: sealed.seq, hash: sealed.hash };
      seqs.push(Number(sealed.seq));
    }
    return seqs;
  };
  const sealer = (extra: Partial<ConstructorParameters<typeof AuditSealer>[0]> = {}) =>
    new AuditSealer({ db, key: KEY, now: clock, setTimer: manualTimers().setTimer, log: recordingLog().log, ...extra });

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
  });

  it('exports the spec values', () => {
    expect(SEAL_BATCH).toBe(500);
    expect(SEAL_BUSY_MS).toBe(2_000);
    expect(SEAL_IDLE_MS).toBe(5_000);
    expect([1, 2, 3, 7, 8, 30].map(backoff)).toEqual([5_000, 10_000, 20_000, 300_000, 300_000, SEAL_BACKOFF_MAX_MS]);
    expect(typeof AUDIT_CHAIN_LOCK_ID).toBe('bigint');
    expect(AUDIT_CHAIN_LOCK_ID < 2n ** 63n).toBe(true);
  });

  describe('a pass', () => {
    it('the first inserts the genesis anchor and seals existing rows with gapless seqs from 1, in (at, id) order', async () => {
      await insert(db, '01J9ZK3V8Q00000000000000B2', '2026-10-03T00:00:02Z');
      await insert(db, '01J9ZK3V8Q00000000000000A1', '2026-10-03T00:00:01Z');
      await insert(db, '01J9ZK3V8Q00000000000000C2', '2026-10-03T00:00:02Z');
      await insert(db, '01J9ZK3V8Q00000000000000A0', '2026-10-03T00:00:03Z');
      expect(await readAnchor(db)).toBeUndefined();
      expect(await sealer().runOnce()).toEqual({ outcome: 'sealed', sealed: 4, nextDelayMs: SEAL_BUSY_MS });
      expect(await readAnchor(db)).toEqual({ seq: 0n, hash: genesisHash(KEY), keyId: keyId(KEY), headSeq: 4n });
      expect(await rows()).toEqual([
        ['01J9ZK3V8Q00000000000000A1', 1],
        ['01J9ZK3V8Q00000000000000B2', 2],
        ['01J9ZK3V8Q00000000000000C2', 3],
        ['01J9ZK3V8Q00000000000000A0', 4],
      ]);
    });

    it('every link recomputed with canonical.ts matches chain_hash, across batches', async () => {
      for (let n = 1; n <= 5; n++) await record(db, event(n));
      const s = sealer({ batchSize: 2 });
      expect((await s.runOnce()).sealed).toBe(2);
      expect((await s.runOnce()).sealed).toBe(2);
      expect((await s.runOnce()).sealed).toBe(1);
      expect(await s.runOnce()).toEqual({ outcome: 'idle', sealed: 0, nextDelayMs: SEAL_IDLE_MS });
      expect(await walk()).toEqual([1, 2, 3, 4, 5]);
    });

    it('a row committed late, with an earlier at than sealed rows, gets the next seq', async () => {
      await insert(db, '01J9ZK3V8Q00000000000000L2', '2026-10-03T00:00:02Z');
      await insert(db, '01J9ZK3V8Q00000000000000L3', '2026-10-03T00:00:03Z');
      const s = sealer();
      expect((await s.runOnce()).sealed).toBe(2);
      await insert(db, '01J9ZK3V8Q00000000000000L1', '2026-10-03T00:00:01Z');
      expect((await s.runOnce()).sealed).toBe(1);
      expect(await rows()).toEqual([
        ['01J9ZK3V8Q00000000000000L2', 1],
        ['01J9ZK3V8Q00000000000000L3', 2],
        ['01J9ZK3V8Q00000000000000L1', 3],
      ]);
      expect(await walk()).toEqual([1, 2, 3]);
    });

    it('a row inside a transaction still open during a pass is not sealed; the pass after its commit seals it', async () => {
      await insert(db, '01J9ZK3V8Q00000000000000O2', '2026-10-03T00:00:02Z');
      const s = sealer();
      await db.transaction(async (open) => {
        await insert(open, '01J9ZK3V8Q00000000000000O1', '2026-10-03T00:00:01Z');
        // The pass runs on another pool client while this transaction holds its uncommitted row.
        expect((await s.runOnce()).sealed).toBe(1);
        const inside = await open.query<{ seq: string | null }>(
          `select chain_seq::text as seq from audit_events where id = '01J9ZK3V8Q00000000000000O1'`,
        );
        expect(inside.rows).toEqual([{ seq: null }]);
      });
      expect(await rows()).toEqual([
        ['01J9ZK3V8Q00000000000000O2', 1],
        ['01J9ZK3V8Q00000000000000O1', null],
      ]);
      expect((await s.runOnce()).sealed).toBe(1);
      expect(await rows()).toEqual([
        ['01J9ZK3V8Q00000000000000O2', 1],
        ['01J9ZK3V8Q00000000000000O1', 2],
      ]);
      expect(await walk()).toEqual([1, 2]);
    });

    it('two sealers on one database never assign the same seq; the loser ends busy-elsewhere', async () => {
      for (let n = 1; n <= 5; n++) await record(db, event(n));
      const held = gated(db, /pg_try_advisory_xact_lock/);
      const winner = sealer({ db: held.db });
      const loser = sealer();
      const first = winner.runOnce();
      await held.entered;
      // The winner holds the lock on its own client; the loser's pass gives up without waiting.
      expect(await loser.runOnce()).toEqual({ outcome: 'busy-elsewhere', sealed: 0, nextDelayMs: SEAL_IDLE_MS });
      held.release();
      expect(await first).toEqual({ outcome: 'sealed', sealed: 5, nextDelayMs: SEAL_BUSY_MS });

      // Then both race freely, in small batches, until the backlog is gone.
      for (let n = 6; n <= 40; n++) await record(db, event(n));
      const a = sealer({ batchSize: 3 });
      const b = sealer({ batchSize: 3 });
      const outcomes: SealPass['outcome'][] = [];
      for (let round = 0; round < 40; round++) {
        const passes = await Promise.all([a.runOnce(), b.runOnce()]);
        outcomes.push(...passes.map((p) => p.outcome));
        // A round that sealed nothing found no row left: the other pass was idle or lost the lock.
        if (passes.every((p) => p.outcome !== 'sealed')) break;
      }
      expect(outcomes).not.toContain('failed');
      expect(outcomes).toContain('idle');
      const seqs = (await rows()).map(([, seq]) => seq);
      expect(seqs).toEqual(Array.from({ length: 40 }, (_, i) => i + 1));
      expect(await walk()).toHaveLength(40);
    });

    it('an anchor with a different key id leaves every row unsealed and logs one error, without the key', async () => {
      await insertGenesis(db, genesisHash(OTHER_KEY), keyId(OTHER_KEY));
      await record(db, event(1));
      await record(db, event(2));
      const { lines, of, log } = recordingLog();
      const s = sealer({ log });
      expect(await s.runOnce()).toEqual({ outcome: 'wrong-key', sealed: 0, nextDelayMs: SEAL_IDLE_MS });
      expect(of('error')).toHaveLength(1);
      expect(of('error')[0]!.args).toEqual([
        { chainKeyId: keyId(OTHER_KEY) },
        `audit chain key does not match the chain's key id ${keyId(OTHER_KEY)}`,
      ]);
      expect(await s.runOnce()).toEqual({ outcome: 'wrong-key', sealed: 0, nextDelayMs: SEAL_IDLE_MS });
      expect(of('error')).toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain(KEY);
      expect(JSON.stringify(lines)).not.toContain(keyId(KEY));
      expect((await rows()).map(([, seq]) => seq)).toEqual([null, null]);
      expect(await readAnchor(db)).toEqual({
        seq: 0n,
        hash: genesisHash(OTHER_KEY),
        keyId: keyId(OTHER_KEY),
        headSeq: 0n,
      });
    });

    it('a sealing pass records head_seq in the anchor; an idle pass leaves it', async () => {
      for (let n = 1; n <= 3; n++) await record(db, event(n));
      const s = sealer();
      expect((await s.runOnce()).sealed).toBe(3);
      expect((await readAnchor(db))?.headSeq).toBe(3n);
      expect((await s.runOnce()).outcome).toBe('idle');
      expect((await readAnchor(db))?.headSeq).toBe(3n);
      await record(db, event(4));
      expect((await s.runOnce()).sealed).toBe(1);
      expect((await readAnchor(db))?.headSeq).toBe(4n);
    });

    it('with every sealed row deleted from outside, the next pass seals at head_seq + 1, linked to the anchor', async () => {
      for (let n = 1; n <= 3; n++) await record(db, event(n));
      const s = sealer();
      await s.runOnce();
      // The old retention, run while the key was unset, deletes by `at` alone.
      await db.query('delete from audit_events');
      await record(db, event(4));
      expect((await s.runOnce()).sealed).toBe(1);
      const anchor = (await readAnchor(db))!;
      expect(anchor.seq).toBe(0n);
      expect(anchor.headSeq).toBe(4n);
      const [row] = await sealedPage(db, 0n, 10);
      expect(row?.seq).toBe(4n);
      expect(row?.hash).toEqual(link(KEY, anchor.hash, 4n, row!.row));
    });

    it('with the newest sealed rows deleted from outside, sealing resumes past the gap from the highest kept row', async () => {
      for (let n = 1; n <= 4; n++) await record(db, event(n));
      const s = sealer();
      await s.runOnce();
      await db.query('delete from audit_events where chain_seq >= 3');
      await record(db, event(5));
      expect((await s.runOnce()).sealed).toBe(1);
      const page = await sealedPage(db, 0n, 10);
      expect(page.map((r) => r.seq)).toEqual([1n, 2n, 5n]);
      expect(page[2]?.hash).toEqual(link(KEY, page[1]!.hash, 5n, page[2]!.row));
      expect((await readAnchor(db))?.headSeq).toBe(5n);
    });

    it('a batch that fails mid-way seals nothing and keeps head_seq; the next pass seals from the same head', async () => {
      await record(db, event(1));
      await record(db, event(2));
      await sealer().runOnce();
      const before = (await sealedPage(db, 1n, 1))[0]!;
      for (let n = 3; n <= 5; n++) await record(db, event(n));
      let updates = 0;
      const failing: Database = {
        query: db.query.bind(db),
        close: () => db.close(),
        transaction: (fn) =>
          db.transaction((tx) =>
            fn({
              query: <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
                if (/^update audit_events set chain_seq/.test(text) && ++updates === 2) {
                  return Promise.reject(new Error('the second seal failed'));
                }
                return tx.query<R>(text, params);
              },
            }),
          ),
      };
      expect(await sealer({ db: failing }).runOnce()).toEqual({
        outcome: 'failed',
        sealed: 0,
        nextDelayMs: backoff(1),
      });
      expect(updates).toBe(2);
      expect((await rows()).map(([, seq]) => seq)).toEqual([1, 2, null, null, null]);
      expect((await readAnchor(db))?.headSeq).toBe(2n);
      const head: ChainLink | undefined = (await sealedPage(db, 1n, 1))[0];
      expect(head?.hash).toEqual(before.hash);
      expect((await sealer().runOnce()).sealed).toBe(3);
      expect(await walk()).toEqual([1, 2, 3, 4, 5]);
      expect((await readAnchor(db))?.headSeq).toBe(5n);
    });

    it('logs the head at info after a batch that sealed something, and not after an empty one', async () => {
      await record(db, event(1));
      await record(db, event(2));
      const { lines, of, log } = recordingLog();
      const s = sealer({ log });
      await s.runOnce();
      const head = (await sealedPage(db, 1n, 1))[0]!;
      expect(of('info')).toEqual([
        { level: 'info', args: [{ sealed: 2 }, `audit chain sealed to 2:${head.hash.toString('hex')}`] },
      ]);
      expect((await s.runOnce()).outcome).toBe('idle');
      expect(of('info')).toHaveLength(1);
      expect(JSON.stringify(lines)).not.toContain(KEY);
    });
  });

  describe('the loop', () => {
    it('passes at start, 2 s while busy, 5 s idle, backing off after a thrown error, then recovers', async () => {
      await record(db, event(1));
      const timers = manualTimers();
      const { of, log } = recordingLog();
      let broken = false;
      const flaky: Database = {
        query: db.query.bind(db),
        close: () => db.close(),
        transaction: (fn) => (broken ? Promise.reject(new Error('connection lost')) : db.transaction(fn)),
      };
      const s = sealer({ db: flaky, setTimer: timers.setTimer, log });
      s.start();
      expect((await s.runOnce()).outcome).toBe('sealed'); // the pass `start` began
      expect(timers.pending(SEAL_BUSY_MS)).toBe(1);
      expect(timers.fire(SEAL_BUSY_MS)).toBe(1);
      expect((await s.runOnce()).outcome).toBe('idle');
      expect(timers.pending(SEAL_IDLE_MS)).toBe(1);

      broken = true;
      timers.fire(SEAL_IDLE_MS);
      expect(await s.runOnce()).toEqual({ outcome: 'failed', sealed: 0, nextDelayMs: backoff(1) });
      expect(timers.pending(backoff(1))).toBe(1);
      timers.fire(backoff(1));
      expect(await s.runOnce()).toEqual({ outcome: 'failed', sealed: 0, nextDelayMs: 10_000 });
      expect(timers.pending(10_000)).toBe(1);
      expect(of('warn')).toHaveLength(1);

      broken = false;
      await record(db, event(2));
      timers.fire(10_000);
      expect((await s.runOnce()).outcome).toBe('sealed');
      expect(of('info').map((l) => l.args[1])).toContain('audit chain sealing recovered');
      expect(timers.pending(SEAL_BUSY_MS)).toBe(1);
      await s.stop();
      expect(timers.pending(SEAL_BUSY_MS) + timers.pending(SEAL_IDLE_MS)).toBe(0);
      expect(await s.runOnce()).toEqual({ outcome: 'stopped', sealed: 0, nextDelayMs: 0 });
      expect(await walk()).toEqual([1, 2]);
    });

    it('stop waits for the pass under way, which commits, and arms nothing after', async () => {
      await record(db, event(1));
      const timers = manualTimers();
      const held = gated(db, /for update skip locked/);
      const s = sealer({ db: held.db, setTimer: timers.setTimer });
      s.start();
      await held.entered;
      let stopped = false;
      const stopping = s.stop().then(() => {
        stopped = true;
      });
      // A macrotask and a database round-trip: a stop that did not wait would have resolved by now.
      await new Promise(setImmediate);
      await db.query('select 1');
      expect(stopped).toBe(false);
      held.release();
      await stopping;
      expect(await rows()).toEqual([[expect.any(String), 1]]);
      expect(timers.pending(SEAL_BUSY_MS) + timers.pending(SEAL_IDLE_MS)).toBe(0);
    });
  });

  it('20 audited actions in parallel transactions all complete while a pass holds its lock; then all are sealed', async () => {
    await record(db, event(0));
    const held = gated(db, /for update skip locked/);
    const s = sealer({ db: held.db });
    const pass = s.runOnce();
    // The pass holds the advisory lock and its claimed row, mid-transaction.
    await held.entered;
    const actions = Array.from({ length: 20 }, (_, i) => db.transaction((tx) => record(tx, event(i + 1))));
    await Promise.all(actions);
    held.release();
    expect((await pass).sealed).toBe(1);
    expect((await sealer().runOnce()).sealed).toBe(20);
    expect((await rows()).map(([, seq]) => seq)).toEqual(Array.from({ length: 21 }, (_, i) => i + 1));
    expect(await walk()).toHaveLength(21);
  });
});

describeDb('the audit chain sealer in a running server (audit-chain spec §3.2)', () => {
  const keys = testKeys();
  const WAIT = { timeout: 5_000, interval: 20 };
  const SEALER_DELAYS = [...new Set([SEAL_BUSY_MS, SEAL_IDLE_MS, ...[1, 2, 3, 4, 5, 6, 7].map(backoff)])];
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
  /** The sealer's armed delay, once its pass under way has finished. */
  async function settled(timers: ManualTimers): Promise<number> {
    let armed: number | undefined;
    await vi.waitFor(() => {
      armed = SEALER_DELAYS.find((ms) => timers.pending(ms) > 0);
      expect(armed).toBeDefined();
    }, WAIT);
    return armed!;
  }
  const chainSeqOf = async (db: Querier, eventId: string) =>
    (await db.query<{ seq: string | null }>('select chain_seq::text as seq from audit_events where id = $1', [eventId]))
      .rows[0]?.seq;
  async function createTeam(h: Awaited<ReturnType<typeof server>>['h']) {
    const admin = await signedInUser(h, { email: 'root@example.com', serverAdmin: true });
    const res = await call<{ id: string }>(h, admin, 'POST', '/teams', { name: 'Payments' });
    expect(res.status).toBe(201);
    const row = await h.db.query<{ id: string }>(
      `select id from audit_events where action = 'team.created' and target_id = $1`,
      [res.body.id],
    );
    return row.rows[0]!.id;
  }

  it('with the key, a real action is sealed after one fired pass', async () => {
    const { h, timers } = await server({ WIREBENCH_SERVER_AUDIT_CHAIN_KEY: KEY });
    await settled(timers); // the pass at start
    const eventId = await createTeam(h);
    expect(await chainSeqOf(h.db, eventId)).toBeNull();
    timers.fire(await settled(timers));
    expect(await settled(timers)).toBe(SEAL_BUSY_MS);
    expect(await chainSeqOf(h.db, eventId)).not.toBeNull();
    expect((await readAnchor(h.db))?.keyId).toBe(keyId(KEY));
  }, 30_000);

  it('without the key, nothing is sealed and no sealer timer is armed', async () => {
    const { h, timers } = await server({});
    // The sweeper's timer is armed at start; the sealer's would be beside it.
    expect(timers.pending(SWEEP_INTERVAL_MS)).toBe(1);
    const eventId = await createTeam(h);
    expect(SEALER_DELAYS.map((ms) => timers.pending(ms))).toEqual(SEALER_DELAYS.map(() => 0));
    expect(await chainSeqOf(h.db, eventId)).toBeNull();
    expect(await readAnchor(h.db)).toBeUndefined();
    const sealed = await h.db.query('select 1 from audit_events where chain_seq is not null');
    expect(sealed.rows).toHaveLength(0);
  }, 30_000);
});
