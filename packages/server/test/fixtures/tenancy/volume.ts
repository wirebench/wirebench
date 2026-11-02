/**
 * The frozen `0019` fixture as a compose installation holds it: its schema, rows and ledger in the `db` service and
 * its data directory in the `server` service's `/data` volume, as a team install at `0019` left them. The browser
 * e2e on a migrated server (`.github/workflows/ci.yml`, `browser-e2e`) and the compose upgrade test
 * (`test/integration/tenancy/upgrade-compose.test.ts`) start from it. `load.ts` does the same for a test schema.
 *
 * It runs under plain Node as well as under vitest, so it imports nothing but Node's own modules: the server's
 * source needs a build first (its `.js` specifiers name files that only a build writes). The migrations are read
 * from their files, as the image's runner reads them, and checked against the ones the fixture recorded.
 *
 *   node packages/server/test/fixtures/tenancy/volume.ts [--free-seat] -- -f e2e/browser/compose.yaml
 *
 * Everything after `--` is passed to `docker compose`. The `db` service must be up; the server must not have
 * started on the volume yet.
 */
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { chmodSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

const HERE = import.meta.dirname;
const MIGRATIONS_DIR = join(HERE, '..', '..', '..', 'migrations');
const FILE_PATTERN = /^(\d{4})_([a-z0-9-]+)\.sql$/;

/** The schema version the fixture is at. */
export const FIXTURE_VERSION = 19;

interface RecordedMigration {
  readonly version: number;
  readonly name: string;
  readonly sha256: string;
}

interface FixtureFile {
  readonly users: Readonly<Record<string, string>>;
  readonly keys: { readonly secretsKey: string };
  readonly dataDirPlaceholder: { readonly token: string; readonly files: readonly string[] };
  readonly migrations: readonly RecordedMigration[];
}

const fixture = JSON.parse(readFileSync(join(HERE, 'fixture-0019.json'), 'utf8')) as FixtureFile;

/** The fixture's `WIREBENCH_SERVER_SECRETS_KEY`: the browser-client values in its data directory are under it. */
export const FIXTURE_SECRETS_KEY = fixture.keys.secretsKey;

/**
 * The migrations whose version, name or SHA-256 differ from `recorded`, or that only one side has, as
 * `<version>_<name>`; empty when they match exactly.
 */
export function migrationDrift(
  today: readonly { readonly version: number; readonly name: string; readonly sql: string }[],
  recorded: readonly RecordedMigration[],
): string[] {
  const hashed = today.map((m) => ({
    version: m.version,
    name: m.name,
    sha256: createHash('sha256').update(m.sql).digest('hex'),
  }));
  const key = (m: RecordedMigration) => `${String(m.version)}_${m.name}:${m.sha256}`;
  const mine = new Set(hashed.map(key));
  const theirs = new Set(recorded.map(key));
  return [...hashed.filter((m) => !theirs.has(key(m))), ...recorded.filter((m) => !mine.has(key(m)))].map(
    (m) => `${String(m.version)}_${m.name}`,
  );
}

/** Migrations `0001` to `0019` from the server's folders, in order, refusing a set that drifted from the fixture's. */
function migrationsTo0019(): { version: number; name: string; sql: string }[] {
  const found: { version: number; name: string; sql: string }[] = [];
  const walk = (dir: string): void => {
    for (const name of readdirSync(dir)) {
      const path = join(dir, name);
      if (statSync(path).isDirectory()) {
        walk(path);
        continue;
      }
      const match = FILE_PATTERN.exec(name);
      if (match !== null && Number(match[1]) <= FIXTURE_VERSION) {
        found.push({ version: Number(match[1]), name: match[2]!, sql: readFileSync(path, 'utf8') });
      }
    }
  };
  walk(MIGRATIONS_DIR);
  found.sort((a, b) => a.version - b.version);
  const drift = migrationDrift(found, fixture.migrations);
  if (drift.length > 0) {
    throw new Error(`migrations 0001 to 0019 differ from those the 0019 fixture was generated with: ${drift.join(', ')}`);
  }
  return found;
}

export interface FixtureSqlOptions {
  /**
   * Disables the account `joined`, so a server whose license is invalid has a community seat left. The fixture's
   * license is signed with a test key, which an image verifies with the production keys only, and its five enabled
   * accounts fill the five community seats: an invitation would be refused `licensing-seat-limit`.
   */
  readonly freeSeat?: boolean;
}

/**
 * The SQL that puts the fixture in an empty database's `public` schema: each migration and its ledger row, as
 * the server's runner writes them, then the rows. `0013` mints a server id; the fixture's own replaces it, since
 * its license is bound to that one. For `psql --single-transaction`.
 */
export function fixtureSql(options: FixtureSqlOptions = {}): string {
  const parts = migrationsTo0019().map(
    (m) =>
      `${m.sql}\n;\ninsert into schema_migrations (version, name) values (${String(m.version)}, '${m.name}');\n`,
  );
  parts.push('delete from server_identity;\n', readFileSync(join(HERE, 'seed-0019.sql'), 'utf8'));
  if (options.freeSeat === true) {
    parts.push(
      `update users set disabled_at = '2026-09-24 12:00:00+00' where id = '${fixture.users['joined']!}';\n`,
    );
  }
  return parts.join('\n');
}

/**
 * Unpacks the data directory into `target`, which must be empty, with the files that named the generator's
 * directory naming `pathInFiles` instead: the directory's path where the server will see it.
 */
export function unpackDataDir(target: string, pathInFiles: string = target): void {
  if (readdirSync(target).length > 0) throw new Error(`${target} is not empty`);
  execFileSync('tar', ['-xzf', join(HERE, 'data-dir-0019.tar.gz'), '-C', target]);
  const to = Buffer.from(pathInFiles, 'utf8');
  const from = Buffer.from(fixture.dataDirPlaceholder.token);
  for (const file of fixture.dataDirPlaceholder.files) {
    const path = join(target, file);
    // Bytes, not text: the files are UTF-8 but the rest of them need not be, and the path may be anything.
    writeFileSync(path, replaceBytes(readFileSync(path), from, to));
  }
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
 * Loads the fixture into a compose installation: the rows into its `db` service (up, empty) as `wirebench`, and the
 * data directory into the `server` service's `/data` volume, owned by the image's user. `compose` is what goes
 * between `docker compose` and the command (`-f`, `-p`, `--env-file`).
 */
export function loadIntoCompose(
  compose: readonly string[],
  options: FixtureSqlOptions & { readonly env?: NodeJS.ProcessEnv } = {},
): void {
  const env = options.env ?? process.env;
  execFileSync(
    'docker',
    [
      'compose',
      ...compose,
      'exec',
      '-T',
      'db',
      'psql',
      '-q',
      '-v',
      'ON_ERROR_STOP=1',
      '--single-transaction',
      '-U',
      'wirebench',
      '-d',
      'wirebench',
    ],
    { input: fixtureSql(options), stdio: 'pipe', env },
  );
  const scratch = mkdtempSync(join(tmpdir(), 'wirebench-fixture-0019-'));
  try {
    unpackDataDir(scratch, '/data');
    // The copy runs as root in the container, so the scratch folder's owner and mode on this machine do not
    // matter, and hands every file to the image's own user.
    chmodSync(scratch, 0o755);
    execFileSync(
      'docker',
      [
        'compose',
        ...compose,
        'run',
        '--rm',
        '--no-deps',
        '--user',
        'root',
        '--entrypoint',
        'sh',
        '-v',
        `${scratch}:/fixture:ro`,
        'server',
        '-c',
        'cp -R /fixture/. /data/ && chown -R node:node /data',
      ],
      { stdio: 'pipe', env },
    );
  } finally {
    rmSync(scratch, { recursive: true, force: true });
  }
}

if (process.argv[1] !== undefined && fileURLToPath(import.meta.url) === process.argv[1]) {
  const args = process.argv.slice(2);
  const dash = args.indexOf('--');
  const own = dash === -1 ? args : args.slice(0, dash);
  const compose = dash === -1 ? [] : args.slice(dash + 1);
  const unknown = own.filter((arg) => arg !== '--free-seat');
  if (unknown.length > 0 || compose.length === 0) {
    process.stderr.write('usage: node volume.ts [--free-seat] -- <docker compose arguments>\n');
    process.exit(2);
  }
  loadIntoCompose(compose, { freeSeat: own.includes('--free-seat') });
}
