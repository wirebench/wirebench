/**
 * The previous image on a reverted database (plan Task 28): the server image built at schema `0019` starts on what
 * `admin tenancy revert` leaves, migrates nothing and answers `/healthz`. It needs Docker and that image, so it runs
 * only when `WIREBENCH_SERVER_0019_IMAGE` names one (`wirebench-server:<tag>` built from `e9bdc5af1`, or any image
 * whose migrations are the fixture's 0001 to 0019, which the test checks first). The container reaches the test
 * database at `WIREBENCH_SERVER_0019_IMAGE_DB_HOST` (`host.docker.internal` by default, Docker Desktop's name for
 * the host). Everywhere else the round trip in `revert.test.ts` compares the catalog with the fixture's instead.
 */
import { execFile } from 'node:child_process';
import { chmod } from 'node:fs/promises';
import { promisify } from 'node:util';
import { afterAll, beforeAll, expect, it } from 'vitest';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations } from '../../../src/serve.js';
import { readTenancyStep, runTenancySteps } from '../../../src/tenancy/file-step.js';
import { revertTenancy } from '../../../src/tenancy/revert.js';
import { Fixture, loadFixture0019, migrationDrift } from '../../fixtures/tenancy/load.js';
import { describeDb, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';

const run = promisify(execFile);
const IMAGE = process.env.WIREBENCH_SERVER_0019_IMAGE ?? '';
const DB_HOST = process.env.WIREBENCH_SERVER_0019_IMAGE_DB_HOST ?? 'host.docker.internal';

/** Prints the image's migrations as the fixture records them: version, name and SHA-256 of each file. */
const LIST_MIGRATIONS = `
const { createHash } = require('node:crypto');
const { readdirSync, readFileSync, statSync } = require('node:fs');
const { join } = require('node:path');
const out = [];
const walk = (dir) => {
  for (const name of readdirSync(dir)) {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) walk(path);
    const m = /^(\\d{4})_([a-z0-9-]+)\\.sql$/.exec(name);
    if (m) out.push({ version: Number(m[1]), name: m[2], sql: readFileSync(path, 'utf8') });
  }
};
walk('/app/migrations');
console.log(JSON.stringify(out));
`;

describeDb('the 0019 image on a reverted database (plan Task 28)', () => {
  let db: TestDatabase;
  let dataDir: string;
  const container = `wbs-revert-0019-${String(process.pid)}`;
  beforeAll(async () => {
    if (IMAGE === '') return;
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-revert-image-');
    await loadFixture0019(db.owner, dataDir);
    // Through 0021: a slice 4 server's database, the revert's only starting point.
    await db.migrate((await allMigrations(BUILTIN_MODULES)).filter((m) => m.version <= 21));
    const root = Buffer.from(Fixture.keys.secretsKey, 'base64');
    expect(await runTenancySteps(db.owner, dataDir, { root })).toBe('done');
    await revertTenancy({
      url: db.ownerUrl,
      dataDir,
      root,
      waitMs: 0,
      serverSessions: () => Promise.resolve([]),
    });
    expect(await readTenancyStep(db.owner)).toBeUndefined();
    // The image runs as its own user, which must write the bind-mounted directory.
    await chmod(dataDir, 0o777);
  }, 120_000);
  afterAll(async () => {
    if (IMAGE === '') return;
    await run('docker', ['rm', '-f', container]).catch(() => undefined);
    await db.close();
    await removeTempDir(dataDir);
  });

  /** The owner's URL as the container reaches it: one URL, as a 0019 installation has. */
  const containerUrl = () => {
    const url = new URL(db.ownerUrl);
    url.hostname = DB_HOST;
    return url.toString();
  };
  const env = () => [
    '-e',
    `WIREBENCH_SERVER_DATABASE_URL=${containerUrl()}`,
    '-e',
    'WIREBENCH_SERVER_PUBLIC_URL=http://localhost:8080',
    '-e',
    'WIREBENCH_SERVER_ALLOW_INSECURE_PUBLIC_URL=true',
    '-e',
    'WIREBENCH_SERVER_DATA_DIR=/data',
    '-e',
    'WIREBENCH_SERVER_HOST=0.0.0.0',
    '-v',
    `${dataDir}:/data`,
    // On Linux the bind mount keeps this machine's owners, so the image runs as this user to write what the
    // revert moved back; Docker Desktop maps the owners itself.
    ...(process.platform === 'linux' && process.getuid !== undefined && process.getgid !== undefined
      ? ['--user', `${String(process.getuid())}:${String(process.getgid())}`, '-e', 'HOME=/tmp']
      : []),
  ];

  it.skipIf(IMAGE === '')(
    'is an image of the fixture’s migrations, finds nothing to migrate, and starts and answers /healthz',
    async () => {
      const listed = await run('docker', ['run', '--rm', '--entrypoint', 'node', IMAGE, '-e', LIST_MIGRATIONS]);
      const migrations = JSON.parse(listed.stdout) as { version: number; name: string; sql: string }[];
      expect(migrationDrift(migrations, Fixture.migrations)).toEqual([]);

      const checked = await run('docker', ['run', '--rm', ...env(), IMAGE, 'migrate', '--check']).catch(
        (error: { stdout?: string; stderr?: string; code?: number }) => error,
      );
      expect(checked.stdout).toContain('up to date');

      await run('docker', ['run', '-d', '--name', container, '-p', '127.0.0.1::8080', ...env(), IMAGE]);
      const port = (await run('docker', ['port', container, '8080'])).stdout.trim().split(':').at(-1)!;
      let health: { status: number; body: unknown } | undefined;
      for (let attempt = 0; attempt < 60 && health?.status !== 200; attempt++) {
        await new Promise((done) => setTimeout(done, 500));
        health = await fetch(`http://127.0.0.1:${port}/healthz`).then(
          async (response) => ({ status: response.status, body: (await response.json()) as unknown }),
          () => undefined,
        );
      }
      const logs = await run('docker', ['logs', container]).catch(() => ({ stdout: '', stderr: '' }));
      expect(health, `${logs.stdout}${logs.stderr}`).toEqual({
        status: 200,
        body: { status: 'ok', checks: { database: 'ok', dataDir: 'ok', git: 'ok' } },
      });
      const meta = await fetch(`http://127.0.0.1:${port}/api/v1/meta`);
      expect(meta.status).toBe(200);
    },
    180_000,
  );
});
