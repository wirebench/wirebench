/**
 * How long migration 0020 keeps a server down (hosted edition spec §19.10). A scaled 0019 fixture (1 million
 * audit_events, 1 million captures, 2 GB of session_log_chunks heap) migrates, and the run yields the two
 * rates of the spec's estimate,
 *
 *   T ≈ Σ over tables of passes × (rows ÷ R + pg_relation_size ÷ B), passes = 1 + rebuilt indexes + composite keys,
 *
 * measured rather than reasoned:
 * - `B`, the sequential heap rate, from a timed single-worker sequential scan of the three scaled tables;
 * - `R`, the row rate, from the measured migration time once the heap term (at `B`) is taken out of it.
 *
 * The first run's figures are committed as `baselines/tenancy-migration.json` (run with
 * `WIREBENCH_PERF_WRITE_BASELINE=1` to write them); afterwards the test fails when either rate falls below
 * a quarter of its baseline. `WIREBENCH_PERF_TENANCY_SCALE` (default 1) shrinks the fixture for a quick try,
 * and is refused with the baseline check, which only means anything at full scale.
 */
import { readFileSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import type { Querier } from '../../src/context.js';
import { migrate } from '../../src/db/migrate.js';
import { createDatabase } from '../../src/db/pool.js';
import { BUILTIN_MODULES } from '../../src/modules.js';
import { allMigrations } from '../../src/serve.js';
import { Fixture, loadFixture0019 } from '../fixtures/tenancy/load.js';
import { UNSCOPED_TABLES } from '../helpers/catalog.js';
import { describeDb, testDatabase } from '../helpers/database.js';
import { mkTempDir, removeTempDir } from '../helpers/git.js';

const SKIP = process.env.WIREBENCH_SKIP_PERF === '1';
const SCALE = Number(process.env.WIREBENCH_PERF_TENANCY_SCALE ?? '1');
const WRITE_BASELINE = process.env.WIREBENCH_PERF_WRITE_BASELINE === '1';
const BASELINE = join(import.meta.dirname, 'baselines', 'tenancy-migration.json');

const AUDIT_ROWS = Math.round(1_000_000 * SCALE);
const CAPTURE_ROWS = Math.round(1_000_000 * SCALE);
/** Under PostgreSQL's 2 kB TOAST threshold, so every byte stays in the heap that each pass reads. */
const CHUNK_BYTES = 1888;
const CHUNK_HEAP = Math.round(2 * 1024 ** 3 * SCALE);

interface Baseline {
  /** Rows a second, one pass. */
  readonly rowsPerSecond: number;
  /** Heap bytes a second, one sequential pass. */
  readonly heapBytesPerSecond: number;
  readonly migrationSeconds: number;
  readonly rows: number;
  readonly heapBytes: number;
  readonly minutesPerMillionRows: number;
  readonly measuredOn: string;
}

interface TableCost {
  readonly table: string;
  readonly rows: number;
  readonly heapBytes: number;
  readonly passes: number;
}

/** Rows and heap size before the migration, and the passes 0020 makes over each scoped table. */
async function costs(db: Querier, sizes: Map<string, { rows: number; heapBytes: number }>): Promise<TableCost[]> {
  const passes = await db.query<{ table: string; indexes: number; keys: number }>(
    `select c.relname as table,
        (select count(*)::int from pg_index x
          join pg_attribute a on a.attrelid = x.indrelid and a.attnum = x.indkey[0]
          where x.indrelid = c.oid and a.attname = 'tenant_id') as indexes,
        (select count(*)::int from pg_constraint k
          where k.conrelid = c.oid and k.contype = 'f' and k.confrelid <> 'tenants'::regclass) as keys
      from pg_class c
      where c.relnamespace = to_regnamespace(current_schema()) and c.relkind = 'r'`,
  );
  return passes.rows
    .filter((row) => sizes.has(row.table))
    .map((row) => ({ table: row.table, ...sizes.get(row.table)!, passes: 1 + row.indexes + row.keys }));
}

describeDb('migration 0020 on a scaled fixture (hosted spec §19.10)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;

  beforeAll(async () => {
    if (SKIP) return;
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-tenancy-perf-');
    await loadFixture0019(db.owner, dataDir);
    const [catchUrl] = Fixture.ids.catch_urls!;
    const [log] = Fixture.ids.session_logs!;
    const { staging } = Fixture.workspaces;
    const { alice } = Fixture.users;
    // Sealed rows past the fixture's chain, and an unsealed tail; a third name a workspace, team and actor.
    await db.owner.query(
      `insert into audit_events (id, at, actor_kind, actor_user_id, action, target_kind, target_id, workspace_id,
         team_id, details, chain_seq, chain_hash)
       select 'PERF' || lpad(i::text, 10, '0'), now() - (i || ' seconds')::interval,
         case when i % 3 = 0 then 'user' else 'system' end, case when i % 3 = 0 then $2 end,
         (array['workspace.pushed', 'team.created', 'secret.set'])[1 + i % 3], 'workspace', $1,
         case when i % 3 = 0 then $1 end, null, jsonb_build_object('n', i),
         case when i % 10 <> 0 then 1000 + i end, case when i % 10 <> 0 then sha256(i::text::bytea) end
       from generate_series(1, $3::int) i`,
      [staging, alice, AUDIT_ROWS],
    );
    await db.owner.query(
      `insert into captures (id, catch_url_id, received_at, method, subpath, query, headers, body, body_size,
         truncated, source_ip)
       select 'PERF' || lpad(i::text, 10, '0'), $1, now() - (i || ' seconds')::interval, 'POST', '', '',
         '[["content-type","application/json"]]'::jsonb, convert_to(repeat(md5(i::text), 6), 'UTF8'), 192,
         false, '203.0.113.7'
       from generate_series(1, $2::int) i`,
      [catchUrl, CAPTURE_ROWS],
    );
    await db.owner.query(
      `insert into session_log_chunks (log_id, offset_bytes, data)
       select $1, 1000000 + i::bigint * $2::int, convert_to(repeat(md5(i::text), $2::int / 32), 'UTF8')
       from generate_series(1, $3::int) i`,
      [log, CHUNK_BYTES, Math.round(CHUNK_HEAP / (CHUNK_BYTES + 40))],
    );
    // An upgraded server's tables are vacuumed: no pass should pay for hint bits the load left unset.
    for (const table of ['audit_events', 'captures', 'session_log_chunks']) {
      await db.owner.query(`vacuum (analyze, parallel 0) ${table}`);
    }
  });
  afterAll(async () => {
    if (SKIP) return;
    await db.close();
    await removeTempDir(dataDir);
  });

  it.skipIf(SKIP)('records R and B, and holds them to a quarter of the baseline', async () => {
    const sizes = new Map<string, { rows: number; heapBytes: number }>();
    const sized = await db.owner.query<{ table: string; rows: string; heap: string }>(
      `select c.relname as table, greatest(c.reltuples, 0)::bigint::text as rows,
          pg_relation_size(c.oid)::text as heap
        from pg_class c where c.relnamespace = to_regnamespace(current_schema()) and c.relkind = 'r'`,
    );
    for (const row of sized.rows) {
      if (!UNSCOPED_TABLES.includes(row.table)) {
        sizes.set(row.table, { rows: Number(row.rows), heapBytes: Number(row.heap) });
      }
    }

    // B: one single-worker sequential pass over the three scaled heaps.
    const scanned = ['audit_events', 'captures', 'session_log_chunks'];
    const scanSeconds = await db.owner.transaction(async (tx) => {
      await tx.query('set local max_parallel_workers_per_gather = 0');
      await tx.query('set local enable_indexscan = off');
      await tx.query('set local enable_indexonlyscan = off');
      await tx.query('set local enable_bitmapscan = off');
      const started = performance.now();
      for (const table of scanned) await tx.query(`select count(*) from ${table}`);
      return (performance.now() - started) / 1000;
    });
    const scannedBytes = scanned.reduce((sum, table) => sum + sizes.get(table)!.heapBytes, 0);
    const heapBytesPerSecond = scannedBytes / scanSeconds;

    // One worker, as the estimate assumes: a parallel index build is faster where the cores are free, so
    // the single-threaded figure is the one an operator can rely on.
    const url = new URL(db.ownerUrl);
    url.searchParams.set('options', `${url.searchParams.get('options') ?? ''} -c max_parallel_maintenance_workers=0`);
    const owner = createDatabase(url.toString());
    let migrationSeconds: number;
    try {
      const migrations = await allMigrations(BUILTIN_MODULES);
      const started = performance.now();
      expect((await migrate(owner, migrations)).applied).toEqual([20]);
      migrationSeconds = (performance.now() - started) / 1000;
    } finally {
      await owner.close();
    }

    // R: what is left of the measured time once every pass's heap read, at B, is taken out.
    const tables = await costs(db.owner, sizes);
    const rowPasses = tables.reduce((sum, t) => sum + t.passes * t.rows, 0);
    const heapSeconds = tables.reduce((sum, t) => sum + (t.passes * t.heapBytes) / heapBytesPerSecond, 0);
    // A heap term at or above the whole time leaves no row term: charge the rows at least a tenth of it.
    const rowSeconds = Math.max(migrationSeconds - heapSeconds, migrationSeconds / 10);
    const rowsPerSecond = rowPasses / rowSeconds;
    const rows = tables.reduce((sum, t) => sum + t.rows, 0);
    const measured: Baseline = {
      rowsPerSecond: Math.round(rowsPerSecond),
      heapBytesPerSecond: Math.round(heapBytesPerSecond),
      migrationSeconds: Number(migrationSeconds.toFixed(2)),
      rows,
      heapBytes: [...sizes.values()].reduce((sum, s) => sum + s.heapBytes, 0),
      minutesPerMillionRows: Number((migrationSeconds / 60 / (rows / 1e6)).toFixed(3)),
      measuredOn: new Date().toISOString().slice(0, 10),
    };
    console.info(
      `[perf] tenancy 0020: ${String(measured.migrationSeconds)} s for ${String(rows)} rows ` +
        `(${String(measured.minutesPerMillionRows)} min per million rows); ` +
        `R ${String(measured.rowsPerSecond)} rows/s, B ${(heapBytesPerSecond / 1024 ** 2).toFixed(0)} MB/s; ` +
        `passes ${tables
          .filter((t) => t.rows > 1000)
          .map((t) => `${t.table} ${String(t.passes)}`)
          .join(', ')}`,
    );

    if (WRITE_BASELINE) {
      expect(SCALE, 'a baseline is written at full scale only').toBe(1);
      writeFileSync(BASELINE, `${JSON.stringify(measured, null, 2)}\n`);
      return;
    }
    if (SCALE !== 1) return;
    const baseline = JSON.parse(readFileSync(BASELINE, 'utf8')) as Baseline;
    expect(measured.rowsPerSecond, 'R').toBeGreaterThan(baseline.rowsPerSecond / 4);
    expect(measured.heapBytesPerSecond, 'B').toBeGreaterThan(baseline.heapBytesPerSecond / 4);
  });
});
