import { existsSync } from 'node:fs';
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { verifyChain } from '../../../src/audit-log/chain/verify.js';
import { FIXTURE_VERSION, loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { scopeOf } from '../../../src/tenancy/scope.js';
import { tenantDbFactory } from '../../../src/tenancy/tenant-db.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

/** Plan Task 3: the frozen `0019` fixture loads, fills every table, and its audit chain verifies. */
describeDb('the frozen 0019 fixture (hosted spec §19.13)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let fixture: Fixture0019;
  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    // Outside Latin-1, so a loader that rewrote the placeholder as Latin-1 text would corrupt the path.
    dataDir = await mkTempDir('wbs-fixture-漢-');
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

  it('holds the edge rows the rebuilt keys must carry: disabled, accepted, revoked, rejected', async () => {
    const one = async (sql: string) => (await db.query(sql)).rows;
    expect(await one('select id from users where disabled_at is not null')).toEqual([{ id: fixture.users.leaver }]);
    expect(await one('select email_lower from invitations where accepted_at is not null')).toEqual([
      { email_lower: 'joined@example.com' },
    ]);
    expect(await one("select id from users where email_lower = 'joined@example.com'")).toEqual([
      { id: fixture.users.joined },
    ]);
    expect(await one('select name from ci_tokens where revoked_at is not null')).toEqual([{ name: 'old pipeline' }]);
    expect((await one('select 1 from captures where rejected')).length).toBe(1);
  });

  it('names no address of the machine that generated it', async () => {
    const seed = await readFile(join(import.meta.dirname, '../../fixtures/tenancy/seed-0019.sql'), 'utf8');
    expect(seed).not.toMatch(/\b(10|192\.168|172\.(1[6-9]|2\d|3[01]))\.\d+\.\d+/);
    expect(seed).toContain('cookies.fixture.test');
  });

  // Through the verifier, not `admin audit verify`: the command refuses a schema with migrations pending, and
  // 0020 is pending here.
  it('has an intact audit chain at 0019 under the test chain key', async () => {
    // At 0019 there is no tenant: any scope's unit reads the one chain, as the setting names no column yet.
    const unscoped = tenantDbFactory(db)(scopeOf({ id: '00000000-0000-4000-8000-000000000000', slug: 'none' }));
    const outcome = await verifyChain(unscoped, fixture.keys.auditChainKey);
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
