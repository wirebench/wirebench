/**
 * `admin tenancy check` and `admin tenancy status` (hosted edition spec §19.10, §19.11): the check is read only on
 * a `0019` database and its data directory, and reports the version, the role, the sizes and an estimate; the
 * status says where the upgrade stands; and the estimate's passes are the ones `0020` makes.
 */
import { randomBytes } from 'node:crypto';
import { mkdir, readdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { migrate } from '../../../src/db/migrate.js';
import { seal } from '../../../src/hooks/secret-box.js';
import { userSecretsKey } from '../../../src/host/server-platform.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { BACKUP_ADVICE, DATA_KEY_TEXT } from '../../../src/tenancy/cli.js';
import { environmentKeyRoot, newDataKey } from '../../../src/tenancy/keys.js';
import { MIGRATION_PASSES } from '../../../src/tenancy/estimate.js';
import { runTenancySteps } from '../../../src/tenancy/file-step.js';
import { loadFixture0019 } from '../../fixtures/tenancy/load.js';
import { SCOPED_TABLES } from '../../helpers/catalog.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

/** The scoped tables that exist at 0019: 0020 creates `host_leases`. */
const SCOPED_0019 = SCOPED_TABLES.filter((table) => table !== 'host_leases');

describeDb('admin tenancy check and status', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  beforeEach(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-tenancy-check-');
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  const env = () => ({
    WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
  });
  const run = async (args: string[], extra: Record<string, string> = {}) => {
    const stdout = { write: vi.fn() };
    const stderr = { write: vi.fn() };
    const code = await main(args, { stdout, stderr, env: { ...env(), ...extra } });
    return {
      code,
      out: stdout.write.mock.calls.map((c) => String(c[0])).join(''),
      err: stderr.write.mock.calls.map((c) => String(c[0])).join(''),
    };
  };

  /** What a check must leave exactly as it was: the catalog, the two unscoped rows' tables, and every file. */
  const snapshot = async () => {
    const catalog = await db.owner.query(
      `select c.relname, c.relkind, a.attname, a.attnum
         from pg_class c left join pg_attribute a on a.attrelid = c.oid and a.attnum > 0 and not a.attisdropped
        where c.relnamespace = to_regnamespace(current_schema()) order by 1, 4`,
    );
    const ledger = await db.owner.query('select version, name from schema_migrations order by version');
    const identity = await db.owner.query('select * from server_identity');
    const files = (await readdir(dataDir, { recursive: true })).sort();
    return { catalog: catalog.rows, ledger: ledger.rows, identity: identity.rows, files };
  };

  it('on a 0019 installation changes nothing and reports the version, the role, the sizes and an estimate', async () => {
    await loadFixture0019(db.owner, dataDir);
    // This schema's tables only: a bare `analyze` reaches every schema of the shared test database.
    const tables = await db.owner.query<{ name: string }>(
      "select relname as name from pg_class where relnamespace = to_regnamespace(current_schema()) and relkind = 'r'",
    );
    for (const { name } of tables.rows) await db.owner.query(`analyze "${name}"`);
    const before = await snapshot();
    const { code, out, err } = await run(['admin', 'tenancy', 'check']);
    expect(err).toBe('');
    expect(code).toBe(0);
    expect(await snapshot()).toEqual(before);
    expect(out).toMatch(/^PostgreSQL: \d+/m);
    expect(out).toContain('schema version: 19');
    expect(out).toMatch(/^app role: wirebench_app /m);
    expect(out).toMatch(/^backups: .*BYPASSRLS/m);
    expect(out).toContain(`data directory: ${dataDir}`);
    expect(out).toMatch(/repos\/: 3 repositories, to be moved/);
    expect(out).toMatch(/checkouts\/: 1 users, to be moved/);
    expect(out).toMatch(/tmp\/: 1 deleted workspaces kept, 1 scratch entries deleted/);
    expect(out).toContain('same filesystem: yes');
    expect(out).toContain('links: none');
    expect(out).toContain('unknown paths: none');
    expect(out).toMatch(/^ {2}audit_events: \d+ rows, [\d.]+ MiB, [\d.]+ MiB, \d+$/m);
    for (const table of SCOPED_0019) expect(out, table).toContain(`  ${table}: `);
    expect(out).toMatch(/^estimated downtime for the migration: .+ at the measured rate, .+ at the conservative one/m);
    // Self-hosted output never names a tenant's slug.
    expect(out).not.toMatch(/\bslug\b/);
  });

  it('names a path at the data directory root that the move does not know', async () => {
    await loadFixture0019(db.owner, dataDir);
    const { mkdir } = await import('node:fs/promises');
    await mkdir(`${dataDir}/backups-by-hand`);
    const { out } = await run(['admin', 'tenancy', 'check']);
    expect(out).toContain('unknown paths: backups-by-hand');
  });

  it('status prints the step, the default tenant id, the data key, the re-wrap and the backup advice', async () => {
    await migrate(db.owner, await allMigrations(BUILTIN_MODULES));
    const id = (await db.owner.query<{ id: string }>('select default_tenant_id::text as id from server_identity'))
      .rows[0]!.id;
    const files = await run(['admin', 'tenancy', 'status']);
    expect(files.code).toBe(0);
    expect(files.out.split('\n')).toEqual([
      'step: files',
      `default tenant: ${id}`,
      'data key: none',
      're-wrap: not run',
      `backups: ${BACKUP_ADVICE}`,
      '',
    ]);
    // A key made under the root: without the root status only says it exists; with it, that it opens; under
    // another root, that it does not, and what to do. Never anything of the key, its wrap or either root.
    const root = randomBytes(32);
    const other = randomBytes(32);
    const dataKey = newDataKey();
    const wrapped = await environmentKeyRoot(root).wrap(id, dataKey);
    await db.owner.query('update tenants set data_key = $1 where id = $2', [wrapped, id]);
    const cases: [Record<string, string>, string][] = [
      [{}, DATA_KEY_TEXT.made],
      [{ WIREBENCH_SERVER_SECRETS_KEY: root.toString('base64') }, DATA_KEY_TEXT.opens],
      [{ WIREBENCH_SERVER_SECRETS_KEY: other.toString('base64') }, DATA_KEY_TEXT.refused],
    ];
    for (const [extra, line] of cases) {
      const status = await run(['admin', 'tenancy', 'status'], extra);
      expect(status.code, status.err).toBe(0);
      expect(status.out).toContain(`data key: ${line}\n`);
      for (const secret of [wrapped, dataKey, root, other]) {
        expect(status.out).not.toContain(secret.toString('hex'));
        expect(status.out).not.toContain(secret.toString('base64'));
      }
    }
  });

  it('status counts the re-wrap from a dry run: still under the old key before the step, under the data key after', async () => {
    await migrate(db.owner, await allMigrations(BUILTIN_MODULES));
    const id = (await db.owner.query<{ id: string }>('select default_tenant_id::text as id from server_identity'))
      .rows[0]!.id;
    const root = randomBytes(32);
    const user = '01JB3Z9K7Q4ZJ6X1V8W2M5N0PA';
    await mkdir(join(dataDir, 'tenants', id, 'checkouts', user), { recursive: true });
    const sealed = seal(userSecretsKey(root, user), 'old secret').toString('base64');
    await writeFile(
      join(dataDir, 'tenants', id, 'checkouts', user, 'secrets.json'),
      JSON.stringify({ version: 2, entries: { sec_x: { value: sealed, encrypted: true, createdAt: 'x' } } }),
    );
    await db.owner.query("update server_identity set tenancy_step = 'keys'");
    const withRoot = { WIREBENCH_SERVER_SECRETS_KEY: root.toString('base64') };
    expect((await run(['admin', 'tenancy', 'status'])).out).toContain(
      're-wrap: waits for WIREBENCH_SERVER_SECRETS_KEY\n',
    );
    // No key yet: status makes none, and reads nothing it would have to.
    expect((await run(['admin', 'tenancy', 'status'], withRoot)).out).toContain('re-wrap: not run\n');
    expect((await db.owner.query('select data_key from tenants where id = $1', [id])).rows).toEqual([
      { data_key: null },
    ]);
    expect(await runTenancySteps(db.owner, dataDir, { root })).toBe('done');
    const after = await run(['admin', 'tenancy', 'status'], withRoot);
    expect(after.out).toContain(
      're-wrap: 1 blob under the data key, 0 still under the old key, 0 open under neither (left as they were), ' +
        '0 links or other entries skipped\n',
    );
    expect(after.out).not.toContain('old secret');
    expect(after.out).not.toContain(user);
    // The user's directory restored from a backup made before the upgrade (Task 24 review I2): status names what
    // re-seals it, and `migrate` does, at done, saying so in counts alone.
    await writeFile(
      join(dataDir, 'tenants', id, 'checkouts', user, 'secrets.json'),
      JSON.stringify({ version: 2, entries: { sec_x: { value: sealed, encrypted: true, createdAt: 'x' } } }),
    );
    expect((await run(['admin', 'tenancy', 'status'], withRoot)).out).toContain(
      '0 blobs under the data key, 1 still under the old key (the next start, or `wirebench-server migrate`, re-seals them)',
    );
    const migrated = await run(['migrate'], withRoot);
    expect(migrated.code).toBe(0);
    expect(migrated.out).toContain('re-wrap check: 1 found still under the old key');
    expect(migrated.out).not.toContain(user);
    expect((await run(['admin', 'tenancy', 'status'], withRoot)).out).toContain(
      're-wrap: 1 blob under the data key, 0 still under the old key',
    );
    // With nothing to do, the check says nothing.
    expect((await run(['migrate'], withRoot)).out).not.toContain('re-wrap');
  });

  it("the estimate's passes are the ones 0020 makes over each scoped table: one plus each index it builds and each key", async () => {
    const migrations = await allMigrations(BUILTIN_MODULES);
    await migrate(
      db.owner,
      migrations.filter((m) => m.version <= 19),
    );
    const before = await db.owner.query<{ oid: string }>(
      `select x.indexrelid::text as oid from pg_index x join pg_class c on c.oid = x.indrelid
        where c.relnamespace = to_regnamespace(current_schema())`,
    );
    await migrate(
      db.owner,
      migrations.filter((m) => m.version <= 20),
    );
    const passes = await db.owner.query<{ table: string; passes: number }>(
      `select c.relname as table, 1 +
          (select count(*)::int from pg_index x where x.indrelid = c.oid and not (x.indexrelid::text = any ($1::text[]))) +
          (select count(*)::int from pg_constraint k
            where k.conrelid = c.oid and k.contype = 'f' and k.confrelid <> 'tenants'::regclass) as passes
        from pg_class c
       where c.relnamespace = to_regnamespace(current_schema()) and c.relkind = 'r' and c.relname = any ($2::text[])
       order by 1`,
      [before.rows.map((r) => r.oid), SCOPED_0019],
    );
    expect(Object.fromEntries(passes.rows.map((r) => [r.table, r.passes]))).toEqual(MIGRATION_PASSES);
  });
});
