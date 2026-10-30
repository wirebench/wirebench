/**
 * The upgrade the owner ruling of 2026-10-29 protects (Part A review m6): an installation at `0019` whose one
 * URL is the database's bootstrap superuser. It keeps starting, migrates to `0020`, warns that row-level security
 * does not apply to its role, and its accounts still sign in.
 */
import { EventEmitter } from 'node:events';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import { loadFixture0019 } from '../../fixtures/tenancy/load.js';
import { describeDb, TEST_DATABASE_URL, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

describeDb('a 0019 installation on one superuser URL (spec §19.4, owner ruling 2026-10-29)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let server: RunningServer;
  const lines: string[] = [];

  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-superuser-0019-');
    await loadFixture0019(db.owner, dataDir);
    const superuser = new URL(TEST_DATABASE_URL!);
    superuser.searchParams.set('options', `-c search_path=${db.schema}`);
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: superuser.toString(),
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'warn',
    };
    const logStream = new Writable({
      write(chunk: Buffer, _encoding, done) {
        lines.push(chunk.toString('utf8'));
        done();
      },
    });
    server = await startServer(
      env,
      { stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env },
      { signals: new EventEmitter(), exit: vi.fn(), logStream, modules: BUILTIN_MODULES },
    );
  });
  afterAll(async () => {
    await server.close();
    await db.close();
    await removeTempDir(dataDir);
  });

  it('listens, at 0020, with the default tenant loaded', async () => {
    const health = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
    expect(health.status).toBe(200);
    const applied = await db.owner.query<{ version: number }>(
      'select max(version)::int as version from schema_migrations',
    );
    expect(applied.rows[0]!.version).toBe(20);
    expect(server.ctx.tenancy.directory.defaultScope().slug).toBe('default');
  });

  it('logs the warning, naming the superuser', () => {
    const warning = lines
      .map((line) => JSON.parse(line) as { level: number; msg: string; superuser?: boolean })
      .find((line) => line.level === 40 && line.msg.includes('row-level security does not apply'));
    expect(warning?.msg).toMatch(/is a superuser/);
    expect(warning?.superuser).toBe(true);
  });

  it("signs the fixture's admin in with the password it had at 0019", async () => {
    const res = await fetch(`http://127.0.0.1:${String(server.port)}/api/v1/auth/local/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({
        email: 'admin@example.com',
        password: 'fixture-password-0019',
        device: { name: 'upgrade test' },
      }),
    });
    expect(res.status).toBe(201);
    expect(((await res.json()) as { user: { email: string } }).user.email).toBe('Admin@example.com');
  });
});
