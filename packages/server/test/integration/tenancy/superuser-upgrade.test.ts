/**
 * The upgrade the owner ruling of 2026-10-29 protects (Part A review m6): an installation at `0019` whose one
 * URL is the database's bootstrap superuser. It keeps starting, migrates to `0021`, warns that row-level security
 * cannot be relied on for its role, and its accounts still sign in.
 */
import { directoryOf } from '../../../src/tenancy/tenancy.js';
import { EventEmitter } from 'node:events';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { afterAll, beforeAll, expect, it, vi } from 'vitest';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { startServer, type RunningServer } from '../../../src/serve.js';
import { loadFixture0019, type Fixture0019 } from '../../fixtures/tenancy/load.js';
import { describeDb, TEST_DATABASE_URL, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

describeDb('a 0019 installation on one superuser URL (spec §19.4, owner ruling 2026-10-29)', () => {
  let db: Awaited<ReturnType<typeof testDatabase>>;
  let dataDir: string;
  let server: RunningServer;
  let fixture: Fixture0019;
  const lines: string[] = [];

  beforeAll(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir('wbs-superuser-0019-');
    fixture = await loadFixture0019(db.owner, dataDir);
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

  it('listens, at 0021, with the default tenant loaded', async () => {
    const health = await fetch(`http://127.0.0.1:${String(server.port)}/healthz`);
    expect(health.status).toBe(200);
    const applied = await db.owner.query<{ version: number }>(
      'select max(version)::int as version from schema_migrations',
    );
    expect(applied.rows[0]!.version).toBe(21);
    expect(directoryOf(server.ctx.tenancy).defaultScope().slug).toBe('default');
  });

  it('logs the warning, naming the superuser', () => {
    const warning = lines
      .map((line) => JSON.parse(line) as { level: number; msg: string; superuser?: boolean })
      .find((line) => line.level === 40 && line.msg.includes('row-level security cannot be relied on'));
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

  it("moved the fixture's data directory under the default tenant, and every workspace syncs after (spec §19.10)", async () => {
    const t = directoryOf(server.ctx.tenancy).defaultScope().tenantId;
    expect((await readdir(dataDir)).sort()).toEqual(['no-hooks', 'tenants']);
    const tmp = await readdir(join(dataDir, 'tenants', t, 'tmp'));
    expect(tmp.filter((name) => name.startsWith(`removed-${fixture.workspaces.retired}-`))).toHaveLength(1);
    expect(tmp).not.toContain('scratch-0019.txt');
    const base = `http://127.0.0.1:${String(server.port)}/api/v1`;
    const signIn = await fetch(`${base}/auth/local/sign-in`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ email: 'admin@example.com', password: 'fixture-password-0019', device: { name: 'sync' } }),
    });
    const { token } = (await signIn.json()) as { token: string };
    const auth = { authorization: `Bearer ${token}` };
    for (const id of [fixture.workspaces.staging, fixture.workspaces.billing]) {
      const head = await fetch(`${base}/workspaces/${id}/sync/head`, { headers: auth });
      expect(head.status, id).toBe(200);
      const at = ((await head.json()) as { head: string | null }).head;
      expect(at, id).not.toBeNull();
      const snapshot = await fetch(`${base}/workspaces/${id}/sync/snapshot`, { headers: auth });
      expect(snapshot.status, id).toBe(200);
      const body = (await snapshot.json()) as { head: string; files: unknown[] };
      expect(body.head, id).toBe(at);
      expect(body.files.length, id).toBeGreaterThan(0);
    }
    // The deleted workspace stays deleted.
    expect((await fetch(`${base}/workspaces/${fixture.workspaces.retired}/sync/head`, { headers: auth })).status).toBe(
      404,
    );
  });
});
