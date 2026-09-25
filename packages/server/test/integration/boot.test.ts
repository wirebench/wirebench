import { EventEmitter } from 'node:events';
import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { ServerModule } from '../../src/context.js';
import { main } from '../../src/main.js';
import { startServer, StartupError } from '../../src/serve.js';
import { describeDb, testDatabase } from '../helpers/database.js';
import { mkTempDir, removeTempDir } from '../helpers/git.js';
import { freePort } from '../helpers/net.js';

/** One module with a route that takes `ms` to answer, to have a request in flight at shutdown. */
const slowModule = (ms: number): ServerModule => ({
  name: 'identity',
  register: (app) => {
    app.get('/slow', async () => {
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { done: true };
    });
    return Promise.resolve();
  },
});

describeDb('startServer', () => {
  let dataDir: string;
  let port: number;
  let db: Awaited<ReturnType<typeof testDatabase>>;
  const env = () => ({
    WIREBENCH_SERVER_DATABASE_URL: db.url,
    WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
    WIREBENCH_SERVER_DATA_DIR: dataDir,
    WIREBENCH_SERVER_HOST: '127.0.0.1',
    WIREBENCH_SERVER_PORT: String(port),
    WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
  });
  const io = () => ({ stdout: { write: vi.fn() }, stderr: { write: vi.fn() }, env: env() });
  beforeEach(async () => {
    dataDir = await mkTempDir();
    port = await freePort();
    db = await testDatabase();
  });
  afterEach(async () => {
    await db.close();
    await removeTempDir(dataDir);
  });

  it('migrates, prepares the data dir, listens, and answers healthz and meta', async () => {
    const exit = vi.fn();
    const server = await startServer(env(), io(), { signals: new EventEmitter(), exit });
    try {
      expect(server.port).toBe(port);
      expect((await fetch(`http://127.0.0.1:${server.port}/healthz`)).status).toBe(200);
      const meta: unknown = await (await fetch(`http://127.0.0.1:${server.port}/api/v1/meta`)).json();
      expect(meta).toMatchObject({ name: 'wirebench-server', apiVersion: 1, publicUrl: 'https://wirebench.test' });
      expect((await db.query('select version from schema_migrations')).rowCount).toBe(1);
    } finally {
      await server.close();
    }
    expect(exit).not.toHaveBeenCalled();
  });

  it('shuts down on SIGTERM after draining an in-flight request', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const server = await startServer(env(), io(), { signals, exit, modules: [slowModule(300)] });
    const inFlight = fetch(`http://127.0.0.1:${server.port}/api/v1/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGTERM');
    expect((await inFlight).status).toBe(200);
    await server.close();
    await expect(fetch(`http://127.0.0.1:${server.port}/healthz`)).rejects.toThrow();
    expect(exit).not.toHaveBeenCalled();
    expect(signals.listenerCount('SIGTERM') + signals.listenerCount('SIGINT')).toBe(0);
  });

  it('exits 130 at once on a second signal', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const server = await startServer(env(), io(), { signals, exit, modules: [slowModule(300)] });
    const inFlight = fetch(`http://127.0.0.1:${server.port}/api/v1/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGTERM');
    expect(exit).not.toHaveBeenCalled();
    signals.emit('SIGTERM');
    expect(exit).toHaveBeenCalledTimes(1);
    expect(exit).toHaveBeenLastCalledWith(130);
    await inFlight;
    await server.close();
  });

  it('when draining outlasts drainMs, drops the remaining connections, closes the pool and does not exit', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const server = await startServer(env(), io(), { signals, exit, drainMs: 100, modules: [slowModule(2_000)] });
    const inFlight = fetch(`http://127.0.0.1:${server.port}/api/v1/slow`);
    await new Promise((resolve) => setTimeout(resolve, 50));
    const started = Date.now();
    signals.emit('SIGTERM');
    await expect(inFlight).rejects.toThrow(); // its connection was dropped at the deadline
    await server.close();
    expect(Date.now() - started).toBeLessThan(1_500);
    expect(exit).not.toHaveBeenCalled();
    await expect(server.ctx.db.query('select 1')).rejects.toThrow(); // the pool is closed
  });

  it('close() lets work holding a repository lock finish before the pool closes, then refuses new work', async () => {
    const server = await startServer(env(), io(), { signals: new EventEmitter(), exit: vi.fn() });
    const workspaceId = '01J8ZC5Q0V7R3T9XK2M4N6P8QA';
    let release: () => void = () => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    // What a push does after its connection is gone: it still holds the lock and still queries.
    const holder = server.ctx.repos.withLock(workspaceId, async () => {
      await gate;
      return (await server.ctx.db.query<{ ok: number }>('select 1 as ok')).rows[0]?.ok;
    });
    const closing = server.close();
    await new Promise((resolve) => setTimeout(resolve, 50)); // app.close() has long resolved by now
    release();
    expect(await holder).toBe(1); // the pool was still open when the holder reached it
    await closing;
    await expect(server.ctx.db.query('select 1')).rejects.toThrow(); // and closed after it
    await expect(server.ctx.repos.withLock(workspaceId, () => Promise.resolve(1))).rejects.toMatchObject({
      code: 'server-shutting-down',
    });
  });

  it('main serve returns 0 after a SIGTERM whose drain timed out', async () => {
    const signals = new EventEmitter();
    const exit = vi.fn();
    const running = main(['serve'], io(), { signals, exit, drainMs: 100, modules: [slowModule(2_000)] });
    let reachable = false;
    for (let attempt = 0; attempt < 100 && !reachable; attempt += 1) {
      reachable = await fetch(`http://127.0.0.1:${port}/healthz`).then(
        () => true,
        () => false,
      );
      if (!reachable) await new Promise((resolve) => setTimeout(resolve, 20));
    }
    expect(reachable).toBe(true);
    const inFlight = fetch(`http://127.0.0.1:${port}/api/v1/slow`).catch(() => undefined);
    await new Promise((resolve) => setTimeout(resolve, 50));
    signals.emit('SIGTERM');
    expect(await running).toBe(0);
    await inFlight;
    expect(exit).not.toHaveBeenCalled();
  });

  it('refuses to start when the port is taken, naming the address, and releases the pool', async () => {
    const first = await startServer(env(), io(), { signals: new EventEmitter(), exit: vi.fn() });
    try {
      const error = await startServer(env(), io(), { signals: new EventEmitter(), exit: vi.fn() }).catch(
        (caught: unknown) => caught,
      );
      expect(error).toBeInstanceOf(StartupError);
      expect(error).toMatchObject({ exitCode: 2 });
      expect((error as StartupError).message).toContain(`127.0.0.1:${port}`);
    } finally {
      await first.close();
    }
  });

  it('exits 3 when the database is newer than this server', async () => {
    const first = await startServer(env(), io(), { signals: new EventEmitter(), exit: vi.fn() });
    await first.close();
    await db.query('insert into schema_migrations (version, name) values (99, $1)', ['future']);
    await expect(startServer(env(), io(), { signals: new EventEmitter(), exit: vi.fn() })).rejects.toMatchObject({
      exitCode: 3,
    });
    for (const command of [['serve'], ['migrate'], ['migrate', '--check']]) {
      const stderr = { write: vi.fn() };
      const code = await main(command, { stdout: { write: vi.fn() }, stderr, env: env() }, { exit: vi.fn() });
      expect(code).toBe(3);
      const text = stderr.write.mock.calls.map((call) => String(call[0])).join('');
      expect(text).toContain('server-schema-too-new: ');
      expect(text).not.toContain('migration failed');
    }
  });

  it('exits 2 naming the variable when configuration is missing, without values', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(['serve'], {
      stdout: { write: vi.fn() },
      stderr,
      env: { WIREBENCH_SERVER_DATABASE_URL: 'postgres://s3cret@x/y' },
    });
    expect(code).toBe(2);
    const text = stderr.write.mock.calls.map((call) => String(call[0])).join('');
    expect(text).toContain('WIREBENCH_SERVER_PUBLIC_URL');
    expect(text).not.toContain('s3cret');
  });

  it('migrate exits 2 on invalid configuration instead of throwing', async () => {
    const stderr = { write: vi.fn() };
    const code = await main(['migrate'], { stdout: { write: vi.fn() }, stderr, env: {} });
    expect(code).toBe(2);
    expect(stderr.write.mock.calls.map((call) => String(call[0])).join('')).toContain('WIREBENCH_SERVER_DATABASE_URL');
  });
});
