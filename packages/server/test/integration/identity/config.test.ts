import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerModule } from '../../../src/context.js';
import { identityModule } from '../../../src/identity/module.js';
import { main } from '../../../src/main.js';
import { BUILTIN_MODULES } from '../../../src/modules.js';
import { allMigrations, startServer } from '../../../src/serve.js';
import { describeDb, testDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { freePort } from '../../helpers/net.js';

/**
 * The other built-in modules' migrations without their routes. Identity owns 0002 and 0018
 * (browser sessions), and versions must be contiguous across modules, so identity alone no longer
 * migrates: the versions between come from the modules registered after it.
 */
const otherMigrations: ServerModule = {
  name: 'teams-access', // any known name; it registers nothing
  migrationsDir: BUILTIN_MODULES.filter((m) => m.name !== 'identity').flatMap((m) =>
    m.migrationsDir === undefined ? [] : typeof m.migrationsDir === 'string' ? [m.migrationsDir] : [...m.migrationsDir],
  ),
  register: () => Promise.resolve(),
};

describeDb('identity module boot', () => {
  let dataDir: string;
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = (extra: Record<string, string> = {}) => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    ...extra,
  });
  const io = (e: NodeJS.ProcessEnv) => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: e });
  beforeEach(async () => {
    dataDir = await mkTempDir();
    db = await testDatabase();
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('brings 0002_identity into the migration list right after the host, and 0018_browser-sessions later', async () => {
    const names = (await allMigrations([identityModule(), otherMigrations])).map((m) => `${m.version}_${m.name}`);
    expect(names.slice(0, 2)).toEqual(['1_init', '2_identity']);
    expect(names).toContain('18_browser-sessions');
    await expect(allMigrations([identityModule()])).rejects.toThrow(/not contiguous at 18/);
  });

  it('applies the identity tables and reports local auth in meta by default', async () => {
    const e = env({ WIREBENCH_SERVER_PORT: String(await freePort()) });
    const server = await startServer(e, io(e), {
      signals: new EventEmitter(),
      exit: vi.fn(),
      modules: [identityModule({ sweepIntervalMs: 0 }), otherMigrations],
    });
    try {
      const meta: unknown = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/meta`)).json();
      expect(meta).toMatchObject({ auth: { local: true, oidc: false }, capabilities: ['identity'] });
      expect((await db.query("select to_regclass('users') is not null as ok")).rows[0]).toEqual({ ok: true });
      const versions = (await db.query('select version from schema_migrations order by version')).rows;
      expect(versions.slice(0, 2)).toEqual([{ version: 1 }, { version: 2 }]);
      expect(versions).toContainEqual({ version: 18 });
    } finally {
      await server.close();
    }
  });

  it('serve exits 2 with identity-no-method when both methods are off', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(
      ['serve'],
      { stdout: { write: vi.fn() }, stderr, env: env({ WIREBENCH_SERVER_LOCAL_AUTH: 'false' }) },
      { exit: vi.fn() },
    );
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((c) => String(c[0])).join('')).toContain('identity-no-method');
  });

  it('config check prints the redirect URI once an issuer is configured, never the secret', async () => {
    const stdout = { write: vi.fn() };
    const code = await main(['config', 'check'], {
      stdout,
      stderr: { write: vi.fn() },
      env: env({
        WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test',
        WIREBENCH_SERVER_OIDC_CLIENT_ID: 'c',
        WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 'top-secret',
      }),
    });
    expect(code).toBe(0);
    const text = stdout.write.mock.calls.map((c) => String(c[0])).join('');
    expect(text).toContain('https://wirebench.test/api/v1/auth/oidc/callback');
    expect(text).not.toContain('top-secret');
  });
});
