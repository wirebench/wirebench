/**
 * `serve` in hosted mode (hosted edition spec §22.1, §22.2; slice 7 Task 32, deferred from Part A): from the
 * environment, through `loadConfig`, the server opens the control pool on the control role's URL and hands it to the
 * control-plane module alone, which then serves the billing webhook; the context's configuration carries none of the
 * database URLs nor the webhook's secret at run time; a superuser app connection refuses the start; and a
 * self-hosted server never opens the pool, so the module serves nothing of hosted mode's. Every value is a placeholder.
 */
import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import { startServer, type RunningServer } from '../../../src/serve.js';
import { describeDb, TEST_DATABASE_URL, testDatabase, type TestDatabase } from '../../helpers/database.js';
import { mkTempDir, removeTempDir } from '../../helpers/git.js';
import { hostedEnv, TEST_ENTRY_HOST, TEST_PADDLE_WEBHOOK_SECRET } from '../../helpers/hosted-env.js';
import { freePort } from '../../helpers/net.js';
import { SERVED_MODULES } from '../../helpers/browser-build.js';

// The control pool's opener, watched: which URL it is given, and whether it is called at all.
const opened = vi.hoisted(() => ({ urls: [] as string[] }));
vi.mock('../../../src/control-plane/control-db.js', async (importOriginal) => {
  const original = await importOriginal<typeof import('../../../src/control-plane/control-db.js')>();
  return {
    ...original,
    openControlDb: (
      url: string,
      ...rest: Parameters<typeof original.openControlDb> extends [string, ...infer R] ? R : never
    ) => {
      opened.urls.push(url);
      return original.openControlDb(url, ...rest);
    },
  };
});

const io = () => ({ stdout: { write: () => true }, stderr: { write: () => true } });

describeDb('serve in hosted mode (spec §22.1, §22.2)', () => {
  let db: TestDatabase;
  let dataDir: string;
  let running: RunningServer | undefined;
  beforeEach(async () => {
    db = await testDatabase({ migrated: false });
    dataDir = await mkTempDir();
    opened.urls.length = 0;
  });
  afterEach(async () => {
    await running?.close();
    running = undefined;
    await db.close();
    await removeTempDir(dataDir);
  });

  const hosted = async (overrides: Record<string, string> = {}) => ({
    ...hostedEnv({
      db,
      dataDir,
      port: await freePort(),
      internalPort: await freePort(),
      // Nothing listens: this file sends no mail.
      smtpPort: await freePort(),
    }),
    ...overrides,
  });
  const start = (env: Record<string, string>) =>
    startServer(env, { ...io(), env }, { modules: SERVED_MODULES, signals: new EventEmitter(), exit: vi.fn() });
  /** An unsigned post to the webhook: `401` when the module serves it, `404` when nothing does. */
  const unsignedWebhook = (server: RunningServer) =>
    server.app.inject({
      method: 'POST',
      url: '/billing/paddle',
      headers: { host: TEST_ENTRY_HOST, 'content-type': 'application/json' },
      payload: '{}',
    });

  it('opens the control pool on the control role’s URL, for the control-plane module, which serves the webhook', async () => {
    const env = await hosted();
    running = await start(env);
    expect(opened.urls).toEqual([db.controlUrl]);
    expect((await unsignedWebhook(running)).statusCode).toBe(401);
    // The pool is the control role's: start-up checked it on its first query (spec §22.2).
    const sessions = await db.owner.query<{ n: number }>(
      "select count(*)::int as n from pg_stat_activity where usename = 'wirebench_control'",
    );
    expect(sessions.rows[0]!.n).toBeGreaterThan(0);
  });

  it('keeps every database URL and the webhook secret off the context’s configuration at run time', async () => {
    const env = await hosted();
    running = await start(env);
    const config = running.ctx.config as unknown as Record<string, unknown>;
    expect(config['mode']).toBe('hosted');
    for (const key of ['databaseUrl', 'migrationDatabaseUrl', 'controlDatabaseUrl', 'paddleWebhookSecret'])
      expect(Object.keys(config), key).not.toContain(key);
    const text = JSON.stringify(config);
    for (const value of [db.controlUrl, db.ownerUrl, db.url, TEST_PADDLE_WEBHOOK_SECRET])
      expect(text).not.toContain(value);
  });

  it('refuses to start on a superuser app connection', async () => {
    const superuser = new URL(TEST_DATABASE_URL!);
    superuser.searchParams.set('options', `-c search_path=${db.schema}`);
    const env = await hosted({ WIREBENCH_SERVER_DATABASE_URL: superuser.toString() });
    await expect(start(env)).rejects.toMatchObject({
      message: expect.stringMatching(/^tenancy-role-bypasses: .*is a superuser/) as unknown,
    });
  });

  it('never opens the pool on a self-hosted server, where the module serves nothing of hosted mode', async () => {
    const env = {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_MIGRATION_DATABASE_URL: db.ownerUrl,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_HOST: '127.0.0.1',
      WIREBENCH_SERVER_PORT: String(await freePort()),
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
    };
    running = await start(env);
    expect(running.ctx.config.mode).toBe('self-hosted');
    expect(opened.urls).toEqual([]);
    expect((await unsignedWebhook(running)).statusCode).toBe(404);
    const signup = await running.app.inject({ method: 'GET', url: '/signup', headers: { host: TEST_ENTRY_HOST } });
    // No signup form: the path is only one of the browser client's pages, which sends a caller with no session to sign in.
    expect(signup.statusCode).toBe(303);
    expect(signup.headers['location']).toMatch(/^\/sign-in/);
  });
});
