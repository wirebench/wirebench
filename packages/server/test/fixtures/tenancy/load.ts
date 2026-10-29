/**
 * The frozen `0019` fixture (hosted edition spec §19.13): a database and a data directory as the server left
 * them at commit `e9bdc5af1`, the last schema at `0019`. `make-fixture-0019.ts` wrote the three files next to
 * this one from that commit's own code; nothing here runs today's repositories, which later tasks rewrite.
 */
import { execFileSync } from 'node:child_process';
import { readdirSync, readFileSync } from 'node:fs';
import { readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { Database } from '../../../src/context.js';
import { migrate } from '../../../src/db/migrate.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';

const HERE = import.meta.dirname;

/** The schema version the fixture is at. */
export const FIXTURE_VERSION = 19;

export interface Fixture0019 {
  readonly commit: string;
  /** Ids by table, for the rows the generator named. */
  readonly ids: Readonly<Record<string, readonly string[]>>;
  readonly users: { readonly admin: string; readonly alice: string; readonly editor: string; readonly viewer: string };
  /** `retired` was deleted: its repository is in `tmp/removed-…`. */
  readonly workspaces: { readonly staging: string; readonly billing: string; readonly retired: string };
  /** Alice's host checkout, relative to the data directory: `secrets.json` and `cookie-jars/` are in it. */
  readonly checkout: string;
  /** The files that named the generator's data directory, which the loader points at the new one. */
  readonly dataDirPlaceholder: { readonly token: string; readonly files: readonly string[] };
  /** The sealed audit rows: `chain_seq` from `firstSeq` to `lastSeq`, then `unsealed` rows with none. */
  readonly chain: { readonly firstSeq: string; readonly lastSeq: string; readonly unsealed: number };
  /** The configuration keys every sealed value is under. */
  readonly keys: {
    readonly secretsKey: string;
    readonly auditChainKey: string;
    readonly hooksSecretKey: string;
    readonly schedulesSecretKey: string;
  };
  /** The plaintexts behind the sealed values. */
  readonly plaintexts: {
    readonly hostSecret: string;
    readonly hostSecretLabel: string;
    readonly cookies: { readonly staging: string; readonly billing: string };
    readonly hookSignatureSecret: string;
    readonly scheduleSecret: string;
    readonly slackUrl: string;
  };
}

export const Fixture: Fixture0019 = JSON.parse(readFileSync(join(HERE, 'fixture-0019.json'), 'utf8')) as Fixture0019;

/**
 * Migrates `owner`'s schema to `0019` (and no further, whatever later migrations exist), loads the rows, and
 * unpacks the data directory into `dataDir`, which must be empty. `0013` mints a server id; the fixture's own
 * replaces it, since its license is bound to that one.
 */
export async function loadFixture0019(owner: Database, dataDir: string): Promise<Fixture0019> {
  if (readdirSync(dataDir).length > 0) throw new Error(`${dataDir} is not empty`);
  const migrations = (await allMigrations(BUILTIN_MODULES)).filter((m) => m.version <= FIXTURE_VERSION);
  await migrate(owner, migrations);
  const seed = await readFile(join(HERE, 'seed-0019.sql'), 'utf8');
  await owner.transaction(async (tx) => {
    await tx.query('delete from server_identity');
    await tx.query(seed);
  });
  execFileSync('tar', ['-xzf', join(HERE, 'data-dir-0019.tar.gz'), '-C', dataDir]);
  for (const file of Fixture.dataDirPlaceholder.files) {
    const path = join(dataDir, file);
    const text = (await readFile(path)).toString('latin1');
    await writeFile(path, Buffer.from(text.replaceAll(Fixture.dataDirPlaceholder.token, dataDir), 'latin1'));
  }
  return Fixture;
}
