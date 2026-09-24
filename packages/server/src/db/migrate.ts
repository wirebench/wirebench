/**
 * Forward-only, numbered SQL migrations (host spec §3.4): `NNNN_name.sql`, one transaction each,
 * recorded in `schema_migrations`. A database newer than the newest file refuses to start — the
 * mirror of the desktop's `workspace-format-too-new`.
 */
import { readdir, readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../context.js';

export interface Migration {
  readonly version: number;
  readonly name: string;
  readonly sql: string;
}

/** The host's own migrations folder, next to `dist/` and `src/`. */
export const MIGRATIONS_DIR = fileURLToPath(new URL('../../migrations/', import.meta.url));

const FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.sql$/;

/**
 * Loads `NNNN_name.sql` files from `dir`, sorted by version.
 *
 * With `contiguous` (default `true`), the folder must run 0001, 0002, … with no gaps — the host's
 * own migrations folder. With `contiguous: false`, a folder may start at any version and have
 * gaps (a module's own folder, e.g. identity's `0002_identity.sql`); duplicates are still refused.
 * The combined list across host + modules is checked for contiguity elsewhere (Task 7).
 */
export async function loadMigrations(
  dir: string,
  options?: { readonly contiguous?: boolean },
): Promise<readonly Migration[]> {
  const contiguous = options?.contiguous ?? true;
  const files = (await readdir(dir)).filter((file) => FILE_PATTERN.test(file)).sort();
  const migrations = await Promise.all(
    files.map(async (file) => {
      const match = FILE_PATTERN.exec(file)!;
      return { version: Number(match[1]), name: match[2]!, sql: await readFile(join(dir, file), 'utf-8') };
    }),
  );
  const seen = new Set<number>();
  for (const [index, migration] of migrations.entries()) {
    if (seen.has(migration.version)) {
      throw new Error(`duplicate migration version ${migration.version} in ${dir}`);
    }
    seen.add(migration.version);
    if (contiguous && migration.version !== index + 1) {
      throw new Error(
        `migration versions in ${dir} must be contiguous from 0001; found ${migration.version} at position ${index + 1}`,
      );
    }
  }
  return migrations;
}

async function appliedVersions(db: Querier): Promise<number[]> {
  const exists = await db.query<{ exists: boolean }>("select to_regclass('schema_migrations') is not null as exists");
  if (exists.rows[0]?.exists !== true) return [];
  const rows = await db.query<{ version: number }>('select version from schema_migrations order by version');
  return rows.rows.map((row) => Number(row.version));
}

export async function pendingMigrations(db: Querier, migrations: readonly Migration[]): Promise<readonly Migration[]> {
  const applied = new Set(await appliedVersions(db));
  const newest = migrations[migrations.length - 1]?.version ?? 0;
  const tooNew = [...applied].filter((version) => version > newest);
  if (tooNew.length > 0) {
    throw new WirebenchError(
      'server-schema-too-new',
      `The database is at schema version ${Math.max(...tooNew)}, newer than this server's ${newest}. Upgrade the server.`,
    );
  }
  return migrations.filter((migration) => !applied.has(migration.version));
}

export async function migrate(db: Database, migrations: readonly Migration[]): Promise<{ applied: number[] }> {
  const applied: number[] = [];
  for (const migration of await pendingMigrations(db, migrations)) {
    await db.transaction(async (tx) => {
      await tx.query(migration.sql);
      await tx.query('insert into schema_migrations (version, name) values ($1, $2)', [
        migration.version,
        migration.name,
      ]);
    });
    applied.push(migration.version);
  }
  return { applied };
}
