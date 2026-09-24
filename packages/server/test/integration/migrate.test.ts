import { afterEach, beforeEach, expect, it } from 'vitest';
import { loadMigrations, migrate, MIGRATIONS_DIR, pendingMigrations } from '../../src/db/migrate.js';
import { describeDb, testDatabase } from '../helpers/database.js';

describeDb('migrations against PostgreSQL', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  beforeEach(async () => {
    db = await testDatabase();
  });
  afterEach(() => db.close());

  it('applies 0001 once and is then idempotent', async () => {
    const migrations = await loadMigrations(MIGRATIONS_DIR);
    expect((await migrate(db, migrations)).applied).toEqual([1]);
    expect((await migrate(db, migrations)).applied).toEqual([]);
    const tables = await db.query<{ table_name: string }>(
      'select table_name from information_schema.tables where table_schema = $1 order by 1',
      [db.schema],
    );
    expect(tables.rows.map((r) => r.table_name)).toEqual(['schema_migrations', 'workspaces']);
  });

  it('rolls a failing migration back entirely', async () => {
    const broken = [{ version: 1, name: 'broken', sql: 'create table half (); select * from does_not_exist;' }];
    await expect(migrate(db, broken)).rejects.toThrow();
    const tables = await db.query('select table_name from information_schema.tables where table_schema = $1', [
      db.schema,
    ]);
    expect(tables.rowCount).toBe(0);
  });

  it('refuses a newer schema', async () => {
    await migrate(db, await loadMigrations(MIGRATIONS_DIR));
    await db.query('insert into schema_migrations (version, name) values (99, $1)', ['future']);
    await expect(pendingMigrations(db, await loadMigrations(MIGRATIONS_DIR))).rejects.toMatchObject({
      code: 'server-schema-too-new',
    });
  });
});
