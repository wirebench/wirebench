import { fileURLToPath } from 'node:url';
import { afterAll, beforeAll, beforeEach, expect, it } from 'vitest';
import { genesisHash, keyId, link } from '../../../src/audit-log/chain/canonical.js';
import {
  CANONICAL_COLUMNS,
  chainHead,
  claimUnsealed,
  insertGenesis,
  readAnchor,
  sealedPage,
  sealRow,
} from '../../../src/audit-log/repo.js';
import { loadMigrations, migrate, MIGRATIONS_DIR } from '../../../src/db/migrate.js';
import { FIXED_ROW } from '../../helpers/audit-chain.js';
import { describeDb, testDatabase } from '../../helpers/database.js';

const dir = (name: string) => fileURLToPath(new URL(`../../../migrations/${name}/`, import.meta.url));
const KEY = 'test-chain-key-0123456789abcdefghij';

describeDb('the audit chain repo (audit-chain spec §3.2, §4)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;

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

  const insert = (id: string, at: string, details = '{}') =>
    db.query(
      `insert into audit_events (id, at, actor_kind, action, target_kind, details)
       values ($1, $2, 'system', 'team.created', 'team', $3::jsonb)`,
      [id, at, details],
    );

  it('renders a real row to the canonical texts', async () => {
    // details keys in another insertion order and spacing; Postgres normalises them.
    await db.query(
      `insert into audit_events (id, at, actor_kind, actor_user_id, actor_email, action, target_kind, target_id,
         workspace_id, team_id, ip, user_agent, details)
       values ($1, $2, 'user', 'U1', 'zoë@例え.jp', 'workspace.pushed', 'workspace', 'W1', 'W1', null,
         '2001:db8::7', null, $3::jsonb)`,
      [FIXED_ROW.id, '2026-10-03 11:15:42.123456+02', '{"z":[true,null],  "b":"ü","a":1}'],
    );
    const rows = await db.query(`select ${CANONICAL_COLUMNS} from audit_events`);
    expect(rows.rows).toEqual([FIXED_ROW]);
    expect(await claimUnsealed(db, 10)).toEqual([FIXED_ROW]);
  });

  it('renders a whole-second at with six fractional digits', async () => {
    await insert('01J9ZK3V8Q0000000000000002', '2026-10-03T00:00:00Z');
    const [row] = await claimUnsealed(db, 10);
    expect(row?.at).toBe('2026-10-03T00:00:00.000000Z');
    expect(row?.details).toBe('{}');
  });

  it('covers the netmask of ip, and prints a single host without one', async () => {
    for (const [id, ip] of [
      ['01J9ZK3V8Q00000000000000E1', '10.0.0.5'],
      ['01J9ZK3V8Q00000000000000E2', '10.0.0.5/24'],
      ['01J9ZK3V8Q00000000000000E3', '2001:db8::7/128'],
      ['01J9ZK3V8Q00000000000000E4', '2001:db8::7/64'],
    ]) {
      await db.query(
        `insert into audit_events (id, actor_kind, action, target_kind, ip) values ($1, 'system', 'team.created', 'team', $2)`,
        [id, ip],
      );
    }
    expect((await claimUnsealed(db, 10)).map((r) => r.ip)).toEqual([
      '10.0.0.5',
      '10.0.0.5/24',
      '2001:db8::7',
      '2001:db8::7/64',
    ]);
  });

  it('claims through the audit_events_unsealed index, sorting on the table columns', async () => {
    // Explains the very statement claimUnsealed sends: a bare `order by at` would sort on the
    // CANONICAL_COLUMNS text alias, which no index serves.
    const plan = await db.transaction(async (tx) => {
      await tx.query('set local enable_seqscan = off');
      await tx.query('set local enable_sort = off');
      const explained: string[] = [];
      await claimUnsealed(
        {
          query: async <R extends Record<string, unknown>>(text: string, params?: readonly unknown[]) => {
            const rows = await tx.query<R>(`explain ${text}`, params);
            explained.push(...rows.rows.map((r) => String(r['QUERY PLAN'])));
            return { rows: [], rowCount: 0 };
          },
        },
        500,
      );
      return explained.join('\n');
    });
    expect(plan).toContain('audit_events_unsealed');
    expect(plan).not.toMatch(/\bSort\b/);
  });

  it('has no anchor until the genesis, which keeps the first anchor', async () => {
    expect(await readAnchor(db)).toBeUndefined();
    const anchor = await insertGenesis(db, genesisHash(KEY), keyId(KEY));
    expect(anchor).toEqual({ seq: 0n, hash: genesisHash(KEY), keyId: keyId(KEY), headSeq: 0n });
    expect(await insertGenesis(db, Buffer.alloc(32), 'ffffffffffffffff')).toEqual(anchor);
    expect(await readAnchor(db)).toEqual(anchor);
  });

  it('claims unsealed rows in (at, id) order, skips sealed ones and reads the chain back', async () => {
    await insert('01J9ZK3V8Q00000000000000B2', '2026-10-03T00:00:02Z');
    await insert('01J9ZK3V8Q00000000000000A1', '2026-10-03T00:00:01Z');
    await insert('01J9ZK3V8Q00000000000000C2', '2026-10-03T00:00:02Z');
    const anchor = await insertGenesis(db, genesisHash(KEY), keyId(KEY));
    expect(await chainHead(db)).toBeUndefined();

    const claimed = await db.transaction(async (tx) => {
      const rows = await claimUnsealed(tx, 2);
      let head = { seq: anchor.seq, hash: anchor.hash };
      for (const row of rows) {
        const seq = head.seq + 1n;
        head = { seq, hash: link(KEY, head.hash, seq, row) };
        await sealRow(tx, row.id ?? '', seq, head.hash);
      }
      return rows.map((r) => r.id);
    });
    expect(claimed).toEqual(['01J9ZK3V8Q00000000000000A1', '01J9ZK3V8Q00000000000000B2']);

    expect((await claimUnsealed(db, 10)).map((r) => r.id)).toEqual(['01J9ZK3V8Q00000000000000C2']);
    const head = await chainHead(db);
    expect(head?.seq).toBe(2n);

    const page = await sealedPage(db, 0n, 10);
    expect(page.map((r) => [r.seq, r.row.id])).toEqual([
      [1n, '01J9ZK3V8Q00000000000000A1'],
      [2n, '01J9ZK3V8Q00000000000000B2'],
    ]);
    expect(page[1]?.hash).toEqual(head?.hash);
    expect(page[0]?.hash).toEqual(link(KEY, anchor.hash, 1n, page[0]!.row));
    expect(page[1]?.hash).toEqual(link(KEY, page[0]!.hash, 2n, page[1]!.row));
    expect((await sealedPage(db, 1n, 10)).map((r) => r.seq)).toEqual([2n]);
    expect(await sealedPage(db, 0n, 1)).toHaveLength(1);
  });

  it('skips rows another transaction holds', async () => {
    await insert('01J9ZK3V8Q00000000000000D1', '2026-10-03T00:00:01Z');
    await insert('01J9ZK3V8Q00000000000000D2', '2026-10-03T00:00:02Z');
    await db.transaction(async (outer) => {
      expect((await claimUnsealed(outer, 1)).map((r) => r.id)).toEqual(['01J9ZK3V8Q00000000000000D1']);
      const other = await db.transaction((inner) => claimUnsealed(inner, 10));
      expect(other.map((r) => r.id)).toEqual(['01J9ZK3V8Q00000000000000D2']);
    });
  });
});
