import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { FIXTURE_VERSION, loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

/** Plan Task 3: the frozen `0019` fixture loads, fills every table, and its audit chain verifies. */
describeDb('the frozen 0019 fixture (hosted spec §19.13)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let fixture: Fixture0019;
  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-fixture-');
    fixture = await loadFixture0019(db.owner, dataDir);
    await db.grant();
  });
  afterAll(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('is at 0019, with rows in all 37 tables', async () => {
    const versions = (await db.query<{ version: number }>('select version from schema_migrations order by 1')).rows;
    expect(versions.map((row) => Number(row.version))).toEqual(
      Array.from({ length: FIXTURE_VERSION }, (_, i) => i + 1),
    );
    const tables = (
      await db.owner.query<{ table: string }>(
        'select tablename as table from pg_tables where schemaname = current_schema() order by 1',
      )
    ).rows.map((row) => row.table);
    expect(tables).toHaveLength(37);
    const empty: string[] = [];
    for (const table of tables) {
      if ((await db.query(`select 1 from ${table} limit 1`)).rowCount === 0) empty.push(table);
    }
    expect(empty).toEqual([]);
  });

  it('holds the named rows, a sealed chain with an unsealed tail, and its own server id', async () => {
    const users = (await db.query<{ id: string }>('select id from users order by id')).rows.map((row) => row.id);
    expect(users).toEqual([...Object.values(fixture.users)].sort());
    const chain = (
      await db.query<{ first: string; last: string; unsealed: string }>(
        `select min(chain_seq)::text as first, max(chain_seq)::text as last,
           count(*) filter (where chain_seq is null)::text as unsealed from audit_events`,
      )
    ).rows[0]!;
    expect(chain).toEqual({
      first: fixture.chain.firstSeq,
      last: fixture.chain.lastSeq,
      unsealed: String(fixture.chain.unsealed),
    });
    expect(Number(fixture.chain.lastSeq)).toBeGreaterThan(1);
    expect(fixture.chain.unsealed).toBeGreaterThan(0);
    expect((await db.query('select 1 from server_identity')).rowCount).toBe(1);
  });

  // Through the verifier, not `admin audit verify`: the command refuses a schema with migrations pending, and
  // 0020 is pending here.
  it('has an intact audit chain at 0019 under the test chain key', async () => {
    const outcome = await verifyChain(db, fixture.keys.auditChainKey);
    expect(outcome).toMatchObject({
      kind: 'checked',
      result: 'intact',
      firstSeq: BigInt(fixture.chain.firstSeq),
      lastSeq: BigInt(fixture.chain.lastSeq),
      unsealed: fixture.chain.unsealed,
    });
  });

  it('unpacks a data directory with two repositories, a removed one, scratch, and a host checkout', async () => {
    const repos = (await readdir(join(dataDir, 'repos'))).sort();
    expect(repos).toEqual(
      expect.arrayContaining([`${fixture.workspaces.staging}.git`, `${fixture.workspaces.billing}.git`]),
    );
    const tmp = await readdir(join(dataDir, 'tmp'));
    expect(tmp.some((name) => name.startsWith(`removed-${fixture.workspaces.retired}-`))).toBe(true);
    expect(tmp).toContain('scratch-0019.txt');
    const checkout = join(dataDir, fixture.checkout);
    const secrets = await readFile(join(checkout, 'secrets.json'), 'utf8');
    expect(secrets).not.toContain(fixture.plaintexts.hostSecret);
    expect((await readdir(join(checkout, 'cookie-jars'))).sort()).toEqual(
      [`${fixture.workspaces.billing}.json`, `${fixture.workspaces.staging}.json`].sort(),
    );
    for (const jar of await readdir(join(checkout, 'cookie-jars'))) {
      expect(await readFile(join(checkout, 'cookie-jars', jar), 'utf8')).not.toContain('cookie-0019');
    }
    expect(existsSync(join(checkout, 'workspaces', fixture.workspaces.staging, 'server', 'state.yaml'))).toBe(true);
    // The git configs name this data directory, not the generator's.
    for (const file of fixture.dataDirPlaceholder.files) {
      const text = await readFile(join(dataDir, file), 'utf8');
      expect(text).not.toContain(fixture.dataDirPlaceholder.token);
      expect(text).toContain(dataDir);
    }
    expect(fixture.dataDirPlaceholder.files.length).toBeGreaterThan(0);
  });
});
