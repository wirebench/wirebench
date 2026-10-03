/**
 * `wirebench-server admin audit verify` (issue #210, audit-chain spec §3.4) against Postgres: rows are
 * sealed with the real sealer, tampered with through SQL, then checked through the same entry point
 * the other admin commands use.
 */
import type { FastifyBaseLogger } from 'fastify';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import type { ServerCommand } from '../../../src/args.js';
import { keyId } from '../../../src/audit-log/chain/canonical.js';
import { AuditSealer } from '../../../src/audit-log/chain/sealer.js';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { deleteSealedBefore } from '../../../src/audit-log/repo.js';
import type { Database } from '../../../src/context.js';
import { runAdmin } from '../../../src/identity/cli.js';
import { main } from '../../../src/main.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { testKeys } from '../../helpers/licensing.js';
import { manualTimers } from '../../helpers/timers.js';

const KEY = 'test-chain-key-0123456789abcdefghij';
const OTHER_KEY = 'another-chain-key-9876543210zyxwvuts';
const NOW = new Date('2026-10-03T12:00:00Z');
const keys = testKeys();

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

/** `2026-10-03T00:00:<n>Z`: row times in whole seconds. */
const t = (n: number) => `2026-10-03T00:00:${String(n).padStart(2, '0')}Z`;

type VerifyFlags = Omit<Extract<ServerCommand, { command: 'admin-audit-verify' }>, 'command' | 'json'> & {
  json?: boolean;
};

describeDb('wirebench-server admin audit verify (audit-chain spec §3.4)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let ids = 0;
  /** Everything every run wrote, scanned for the key at the end of each test. */
  let written: string[] = [];

  const env = (key: string | undefined) => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    ...(key !== undefined ? { WIREBENCH_SERVER_AUDIT_CHAIN_KEY: key } : {}),
  });
  const io = (key?: string | null) => {
    const out: string[] = [];
    const err: string[] = [];
    return {
      io: {
        stdout: { write: (text: string) => out.push(text) },
        stderr: { write: (text: string) => err.push(text) },
        env: env(key === null ? undefined : (key ?? KEY)),
      },
      stdout: () => out.join(''),
      stderr: () => err.join(''),
    };
  };
  /** Runs the command; `key: null` runs it with no key set. */
  const verify = async (flags: VerifyFlags = {}, key?: string | null) => {
    const run = io(key);
    const code = await runAdmin({ command: 'admin-audit-verify', json: false, ...flags }, run.io, {
      now: () => NOW,
      publicKeys: [keys.publicKey],
    });
    written.push(run.stdout(), run.stderr());
    return { code, stdout: run.stdout(), stderr: run.stderr() };
  };
  /** Inserts a row at `t(n)` by a user, and returns its id; ids sort in insert order. */
  const insert = async (n: number) => {
    ids += 1;
    const id = `01J9ZK3V8Q${String(ids).padStart(16, '0')}`;
    await db.query(
      `insert into audit_events (id, at, actor_kind, actor_user_id, actor_email, action, target_kind, details)
       values ($1, $2, 'user', 'U1', 'ana@example.com', 'team.created', 'team', '{"name":"Payments"}'::jsonb)`,
      [id, t(n)],
    );
    return id;
  };
  const seal = async () =>
    (
      await new AuditSealer({
        db,
        key: KEY,
        now: () => new Date(),
        setTimer: manualTimers().setTimer,
        log: silentLog,
      }).runOnce()
    ).sealed;
  /** Inserts and seals `count` rows at `t(1)`…`t(count)`, returning their ids by seq (index 0 is seq 1). */
  const sealed = async (count: number) => {
    const made: string[] = [];
    for (let n = 1; n <= count; n++) made.push(await insert(n));
    expect(await seal()).toBe(count);
    return made;
  };
  const hashAt = async (seq: number) =>
    (
      await db.query<{ hash: Buffer }>('select chain_hash as hash from audit_events where chain_seq = $1', [seq])
    ).rows[0]!.hash.toString('hex');
  const verifiedEvents = async () =>
    (
      await db.query<{ actor_kind: string; target_kind: string; details: Record<string, unknown> }>(
        `select actor_kind, target_kind, details from audit_events where action = 'audit.verified' order by at, id`,
      )
    ).rows;

  beforeAll(async () => {
    db = await testDatabase();
    const run = io();
    expect(await main(['migrate'], run.io)).toBe(0);
  });
  afterAll(() => db.close());
  beforeEach(async () => {
    await db.query('delete from audit_events');
    await db.query('delete from audit_chain_anchor');
    written = [];
    return () => {
      // The key never reaches the output, errors included.
      for (const text of written) {
        expect(text).not.toContain(KEY);
        expect(text).not.toContain(OTHER_KEY);
      }
    };
  });

  it('an intact chain exits 0 with the right counts; unsealed rows are counted, never broken', async () => {
    await sealed(5);
    await insert(6);
    await insert(7);
    const run = await verify();
    expect(run).toEqual({ code: 0, stdout: 'checked 5 sealed rows, seq 1 to 5; 2 unsealed\nintact\n', stderr: '' });
  });

  it('a chain with nothing sealed, and one with no anchor and no rows, is empty and intact', async () => {
    await insert(1);
    expect(await verify()).toMatchObject({ code: 0, stdout: 'checked 0 sealed rows; 1 unsealed\nempty and intact\n' });
    await db.query('delete from audit_events');
    expect(await verify()).toMatchObject({ code: 0, stdout: 'checked 0 sealed rows; 0 unsealed\nempty and intact\n' });
  });

  it('an edited details is edited at its seq, exit 1', async () => {
    const made = await sealed(5);
    await db.query(`update audit_events set details = '{"name":"Billing"}'::jsonb where chain_seq = 3`);
    expect(await verify()).toEqual({
      code: 1,
      stdout: `checked 2 sealed rows, seq 1 to 2; 0 unsealed\nbroken: edited at seq 3 (row ${made[2]!})\n`,
      stderr: '',
    });
  });

  it('an edited actor_email is edited at its seq', async () => {
    const made = await sealed(4);
    await db.query(`update audit_events set actor_email = 'eve@example.com' where chain_seq = 2`);
    const run = await verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`broken: edited at seq 2 (row ${made[1]!})`);
  });

  it('an edited anchor hash is edited at the first kept row; a removed anchor is edited at the first row', async () => {
    const made = await sealed(3);
    await db.query(`update audit_chain_anchor set hash = sha256('forged'::bytea)`);
    let run = await verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`broken: edited at seq 1 (row ${made[0]!})`);

    await db.query('delete from audit_chain_anchor');
    run = await verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toBe(`checked 0 sealed rows; 1 unsealed\nbroken: edited at seq 1 (row ${made[0]!})\n`);
  });

  it('a deleted middle row is missing at its seq', async () => {
    await sealed(5);
    await db.query('delete from audit_events where chain_seq = 3');
    expect(await verify()).toMatchObject({
      code: 1,
      stdout: 'checked 2 sealed rows, seq 1 to 2; 0 unsealed\nbroken: missing at seq 3\n',
    });
  });

  it('two rows with their chain_seq swapped are edited at the lower seq', async () => {
    const made = await sealed(5);
    await db.query('update audit_events set chain_seq = -1 where chain_seq = 2');
    await db.query('update audit_events set chain_seq = 2 where chain_seq = 4');
    await db.query('update audit_events set chain_seq = 4 where chain_seq = -1');
    const run = await verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`broken: edited at seq 2 (row ${made[3]!})`);
  });

  it('a sealed seq at or below the anchor is out of order', async () => {
    const made = await sealed(5);
    expect(await deleteSealedBefore(db, new Date(Date.parse(t(2)) + 500), 1000)).toBe(2);
    await db.query('update audit_events set chain_seq = 1 where chain_seq = 3');
    const run = await verify();
    expect(run.code).toBe(1);
    expect(run.stdout).toContain(`broken: out of order at seq 1 (row ${made[2]!})`);
  });

  it('the newest rows deleted are missing past the last kept seq, even with every sealed row gone', async () => {
    await sealed(5);
    await db.query('delete from audit_events where chain_seq >= 4');
    expect(await verify()).toMatchObject({
      code: 1,
      stdout: 'checked 3 sealed rows, seq 1 to 3; 0 unsealed\nbroken: missing at seq 4\n',
    });
    await db.query('delete from audit_events');
    expect(await verify()).toMatchObject({
      code: 1,
      stdout: 'checked 0 sealed rows; 0 unsealed\nbroken: missing at seq 1\n',
    });
  });

  it('--head: a head from before the two newest rows were deleted is not found; a wrong hex does not match', async () => {
    await sealed(5);
    const head5 = await hashAt(5);
    const head3 = await hashAt(3);
    expect(await verify({ head: { seq: 5n, hash: head5 } })).toMatchObject({
      code: 0,
      stdout: 'checked 5 sealed rows, seq 1 to 5; 0 unsealed\nhead 5 matches\nintact\n',
    });

    // The attacker deletes the newest rows and lowers head_seq too: only the logged head catches it.
    await db.query('delete from audit_events where chain_seq >= 4');
    await db.query('update audit_chain_anchor set head_seq = 3');
    expect((await verify()).code).toBe(0);
    await db.query(`delete from audit_events where action = 'audit.verified'`);
    expect(await verify({ head: { seq: 5n, hash: head5 } })).toEqual({
      code: 1,
      stdout: 'checked 3 sealed rows, seq 1 to 3; 0 unsealed\nbroken: head 5 not found: newer rows were removed\n',
      stderr: '',
    });
    const wrong = await verify({ head: { seq: 3n, hash: 'ab'.repeat(32) } });
    expect(wrong.code).toBe(1);
    expect(wrong.stdout).toContain('broken: head 3 does not match\n');
    expect((await verify({ head: { seq: 3n, hash: head3 } })).code).toBe(0);
  });

  it('--head older than the kept chain passes once retention moved past it', async () => {
    await sealed(5);
    const head2 = await hashAt(2);
    expect(await deleteSealedBefore(db, new Date(Date.parse(t(3)) + 500), 1000)).toBe(3);
    expect(await verify({ head: { seq: 2n, hash: head2 } })).toMatchObject({
      code: 0,
      stdout: 'checked 2 sealed rows, seq 4 to 5; 0 unsealed\nhead 2 is older than the kept chain\nintact\n',
    });
  });

  it('a malformed --head exits 2 naming the flag', async () => {
    const run = io();
    expect(await main(['admin', 'audit', 'verify', '--head', 'nope'], run.io)).toBe(2);
    expect(run.stderr()).toContain('--head');
    written.push(run.stdout(), run.stderr());
  });

  it('a wrong key exits 2 with the chain key id and records nothing', async () => {
    await sealed(2);
    const run = await verify({}, OTHER_KEY);
    expect(run).toEqual({ code: 2, stdout: '', stderr: `wrong key (chain key id ${keyId(KEY)})\n` });
    expect(await verifiedEvents()).toEqual([]);
  });

  it('no key exits 2 with a config error and records nothing', async () => {
    await sealed(2);
    const run = await verify({}, null);
    expect(run.code).toBe(2);
    expect(run.stdout).toBe('');
    expect(run.stderr).toContain('WIREBENCH_SERVER_AUDIT_CHAIN_KEY');
    expect(await verifiedEvents()).toEqual([]);
  });

  it('--json prints one object with the summary, intact or broken', async () => {
    const made = await sealed(4);
    const intact = await verify({ json: true });
    expect(intact.code).toBe(0);
    expect(JSON.parse(intact.stdout)).toEqual({
      checked: 4,
      firstSeq: '1',
      lastSeq: '4',
      unsealed: 0,
      result: 'intact',
    });
    await db.query(`update audit_events set details = '{}'::jsonb where chain_seq = 2`);
    const broken = await verify({ json: true });
    expect(broken.code).toBe(1);
    expect(JSON.parse(broken.stdout)).toEqual({
      checked: 1,
      firstSeq: '1',
      lastSeq: '1',
      unsealed: 1,
      result: 'broken',
      brokenSeq: '2',
      broken: { seq: '2', id: made[1], reason: 'edited', message: `edited at seq 2 (row ${made[1]!})` },
    });
  });

  it('records audit.verified with the system actor and its details, broken or not', async () => {
    await sealed(3);
    await verify();
    await db.query('delete from audit_events where chain_seq = 2');
    await verify();
    expect(await verifiedEvents()).toEqual([
      {
        actor_kind: 'system',
        target_kind: 'server',
        details: { checked: 3, firstSeq: '1', lastSeq: '3', unsealed: 0, result: 'intact' },
      },
      {
        actor_kind: 'system',
        target_kind: 'server',
        details: { checked: 1, firstSeq: '1', lastSeq: '1', unsealed: 1, result: 'broken', brokenSeq: '2' },
      },
    ]);
    const rows = await db.query<Record<string, unknown>>('select * from audit_events');
    expect(JSON.stringify(rows.rows)).not.toContain(KEY);
  });

  it('reads one snapshot: retention between two pages leaves the walk intact', async () => {
    await sealed(6);
    // Pause the walk after its first page; retention deletes seqs 1 to 4 and moves the anchor meanwhile.
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    let reached: () => void = () => undefined;
    const entered = new Promise<void>((resolve) => {
      reached = resolve;
    });
    const gated: Database = {
      query: db.query.bind(db),
      close: () => db.close(),
      transaction: (fn) =>
        db.transaction((tx) =>
          fn({
            query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
              const result = await tx.query<R>(text, params);
              if (/where chain_seq > \$1 order by chain_seq limit \$2/.test(text)) {
                reached();
                await gate;
              }
              return result;
            },
          }),
        ),
    };
    const walking = verifyChain(gated, KEY, { pageSize: 2 });
    await entered;
    expect(await deleteSealedBefore(db, new Date(Date.parse(t(4)) + 500), 1000)).toBe(4);
    release();
    expect(await walking).toEqual({
      kind: 'checked',
      result: 'intact',
      checked: 6,
      firstSeq: 1n,
      lastSeq: 6n,
      unsealed: 0,
    });
    // A fresh walk starts from the moved anchor.
    expect(await verifyChain(db, KEY)).toMatchObject({ result: 'intact', checked: 2, firstSeq: 5n, lastSeq: 6n });
  });
});
