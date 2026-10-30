/**
 * The frozen `0019` fixture (hosted edition spec §19.13): a database and a data directory as the server left
 * them at commit `e9bdc5af1`, the last schema at `0019`. `make-fixture-0019.ts` wrote the three files next to
 * this one from that commit's own code; nothing here runs today's repositories, which later tasks rewrite.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
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
  /** `leaver` is disabled; `joined` accepted an invitation. */
  readonly users: {
    readonly admin: string;
    readonly alice: string;
    readonly editor: string;
    readonly viewer: string;
    readonly leaver: string;
    readonly joined: string;
  };
  /** `retired` was deleted: its repository is in `tmp/removed-…`. */
  readonly workspaces: { readonly staging: string; readonly billing: string; readonly retired: string };
  /** Alice's host checkout, relative to the data directory: `secrets.json` and `cookie-jars/` are in it. */
  readonly checkout: string;
  /** The files that named the generator's data directory, which the loader points at the new one. */
  readonly dataDirPlaceholder: { readonly token: string; readonly files: readonly string[] };
  /** Migrations `0001` to `0019` as the generator ran them: the loader refuses a set that drifted since. */
  readonly migrations: readonly { readonly version: number; readonly name: string; readonly sha256: string }[];
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
  // The rows fit the schema the generator wrote them under, so a shipped migration edited since is refused.
  const drift = migrationDrift(migrations, Fixture.migrations);
  if (drift.length > 0) {
    throw new Error(`migrations 0001 to 0019 differ from those the 0019 fixture was generated with: ${drift.join(', ')}`);
  }
  await migrate(owner, migrations);
  const seed = await readFile(join(HERE, 'seed-0019.sql'), 'utf8');
  await owner.transaction(async (tx) => {
    await tx.query('delete from server_identity');
    await tx.query(seed);
  });
  execFileSync('tar', ['-xzf', join(HERE, 'data-dir-0019.tar.gz'), '-C', dataDir]);
  for (const file of Fixture.dataDirPlaceholder.files) {
    const path = join(dataDir, file);
    // Bytes, not text: the files are UTF-8 but the rest of them need not be, and dataDir may be anything.
    await writeFile(
      path,
      replaceBytes(await readFile(path), Buffer.from(Fixture.dataDirPlaceholder.token), Buffer.from(dataDir, 'utf8')),
    );
  }
  return Fixture;
}

/** Replaces every `from` with `to` in `bytes`. */
function replaceBytes(bytes: Buffer, from: Buffer, to: Buffer): Buffer {
  const parts: Buffer[] = [];
  let start = 0;
  for (let at = bytes.indexOf(from); at !== -1; at = bytes.indexOf(from, start)) {
    parts.push(bytes.subarray(start, at), to);
    start = at + from.length;
  }
  parts.push(bytes.subarray(start));
  return Buffer.concat(parts);
}

/**
 * The migrations whose version, name or SHA-256 differ from `recorded`, or that only one side has, as
 * `<version>_<name>`; empty when they match exactly.
 */
export function migrationDrift(
  today: readonly { readonly version: number; readonly name: string; readonly sql: string }[],
  recorded: Fixture0019['migrations'],
): string[] {
  const hashed = today.map((m) => ({
    version: m.version,
    name: m.name,
    sha256: createHash('sha256').update(m.sql).digest('hex'),
  }));
  const key = (m: { readonly version: number; readonly name: string; readonly sha256: string }) =>
    `${String(m.version)}_${m.name}:${m.sha256}`;
  const mine = new Set(hashed.map(key));
  const theirs = new Set(recorded.map(key));
  return [...hashed.filter((m) => !theirs.has(key(m))), ...recorded.filter((m) => !mine.has(key(m)))].map(
    (m) => `${String(m.version)}_${m.name}`,
  );
}
