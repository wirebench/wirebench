import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import type { Database, Querier } from '../../src/context.js';
import { loadMigrations, migrate, pendingMigrations } from '../../src/db/migrate.js';

/** Records SQL and answers the ledger queries from `applied`. */
function fakeDb(applied: number[]): Database & { log: string[] } {
  const log: string[] = [];
  const querier: Querier = {
    query: (text) => {
      log.push(text.trim());
      if (/from schema_migrations/i.test(text)) {
        return Promise.resolve({ rows: applied.map((version) => ({ version })) as never[], rowCount: applied.length });
      }
      if (/to_regclass/i.test(text)) {
        return Promise.resolve({ rows: [{ exists: applied.length > 0 }] as never[], rowCount: 1 });
      }
      return Promise.resolve({ rows: [], rowCount: 0 });
    },
  };
  return {
    ...querier,
    log,
    transaction: async (fn) => {
      log.push('BEGIN');
      const result = await fn(querier);
      log.push('COMMIT');
      return result;
    },
    close: () => Promise.resolve(),
  };
}

let dir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), 'wbs-mig-'));
  writeFileSync(join(dir, '0002_second.sql'), 'create table two ();');
  writeFileSync(join(dir, '0001_first.sql'), 'create table one ();');
  writeFileSync(join(dir, 'README.md'), 'ignored');
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

describe('loadMigrations', () => {
  it('reads NNNN_name.sql files in version order and ignores the rest', async () => {
    const migrations = await loadMigrations(dir);
    expect(migrations.map((m) => [m.version, m.name])).toEqual([
      [1, 'first'],
      [2, 'second'],
    ]);
  });
  it('refuses a duplicate version', async () => {
    writeFileSync(join(dir, '0002_dup.sql'), '');
    await expect(loadMigrations(dir)).rejects.toThrow(/duplicate/);
  });
  it('refuses a gap', async () => {
    writeFileSync(join(dir, '0004_gap.sql'), '');
    await expect(loadMigrations(dir)).rejects.toThrow(/contiguous/);
  });
  it('with contiguous: false, allows a folder to start at any version and have gaps', async () => {
    const other = mkdtempSync(join(tmpdir(), 'wbs-mig-mod-'));
    try {
      writeFileSync(join(other, '0002_identity.sql'), 'create table identity ();');
      writeFileSync(join(other, '0005_later.sql'), 'create table later ();');
      const migrations = await loadMigrations(other, { contiguous: false });
      expect(migrations.map((m) => [m.version, m.name])).toEqual([
        [2, 'identity'],
        [5, 'later'],
      ]);
      // still refuses a duplicate version even when non-contiguous
      writeFileSync(join(other, '0005_dup.sql'), '');
      await expect(loadMigrations(other, { contiguous: false })).rejects.toThrow(/duplicate/);
    } finally {
      rmSync(other, { recursive: true, force: true });
    }
  });
});

describe('migrate', () => {
  it('applies only the pending files, each in its own transaction, and records them', async () => {
    const db = fakeDb([1]);
    const result = await migrate(db, await loadMigrations(dir));
    expect(result.applied).toEqual([2]);
    expect(db.log).toEqual(expect.arrayContaining(['BEGIN', 'create table two ();', 'COMMIT']));
    expect(db.log.some((sql) => sql.includes('create table one'))).toBe(false);
    expect(db.log.some((sql) => /insert into schema_migrations/i.test(sql))).toBe(true);
  });
  it('refuses a database newer than the newest file', async () => {
    const db = fakeDb([1, 2, 3]);
    await expect(pendingMigrations(db, await loadMigrations(dir))).rejects.toMatchObject({
      code: 'server-schema-too-new',
    });
  });
  it('reports pending without applying', async () => {
    const db = fakeDb([]);
    const pending = await pendingMigrations(db, await loadMigrations(dir));
    expect(pending.map((m) => m.version)).toEqual([1, 2]);
    expect(db.log.some((sql) => sql.startsWith('create table'))).toBe(false);
  });
});
