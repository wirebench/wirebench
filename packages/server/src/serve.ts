/**
 * The start-up sequence of host spec §3.1 and the shutdown of §3.7: configuration, git,
 * PostgreSQL and migrations, the data directory, then listen. Each failure exits with the code the
 * spec gives and names the thing that failed, never a value.
 */
import type { EventEmitter } from 'node:events';
import { access, constants } from 'node:fs/promises';
import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { GitCli, WirebenchError, findGit } from '@wirebench/engine';
import { ConfigError, loadConfig, type ServerConfig } from './config.js';
import { MetaRegistry, ServerEvents, type ServerContext, type ServerModule } from './context.js';
import { loadMigrations, migrate, MIGRATIONS_DIR, pendingMigrations, type Migration } from './db/migrate.js';
import { createDatabase } from './db/pool.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';
import { NO_HOOKS_DIR, RepoStore } from './repos/repo-store.js';
import { buildServer } from './server.js';

/** The exit code of an interrupted shutdown: a second signal while the first is still draining. */
const EXIT_INTERRUPTED = 130;
const SIGNALS = ['SIGTERM', 'SIGINT'] as const;

export class StartupError extends Error {
  constructor(
    readonly exitCode: number,
    message: string,
  ) {
    super(message);
    this.name = 'StartupError';
  }
}

export interface RunningServer {
  readonly app: FastifyInstance;
  readonly ctx: ServerContext;
  readonly port: number;
  /** Stops accepting, drains in-flight requests, closes the pool. Idempotent. */
  close(): Promise<void>;
}

export interface StartOptions {
  readonly modules?: readonly ServerModule[];
  /** Where SIGTERM/SIGINT come from: `process` in production, an EventEmitter in tests. */
  readonly signals?: EventEmitter;
  /** How long a shutdown waits for in-flight requests before dropping their connections. */
  readonly drainMs?: number;
  /** How a second signal ends the process: `process.exit` in production, a spy in tests. */
  readonly exit?: (code: number) => void;
}

/**
 * Loads the configuration, then deletes the database URL from `process.env`: `GitCli` always
 * spreads `process.env` into git's environment (an `env` option can only add to it), so leaving
 * the variable there would hand the connection string to every git child process.
 */
function configFrom(env: NodeJS.ProcessEnv, io: ServerIo): ServerConfig {
  try {
    const config = loadConfig(env, packageVersion());
    delete process.env.WIREBENCH_SERVER_DATABASE_URL;
    return config;
  } catch (error) {
    if (error instanceof ConfigError) {
      for (const problem of error.problems) io.stderr.write(`${problem.variable}: ${problem.message}\n`);
      throw new StartupError(ExitCode.Config, 'configuration is invalid');
    }
    throw error;
  }
}

async function locateGit(config: ServerConfig): Promise<GitCli> {
  const location = await findGit(config.gitPath !== undefined ? { configuredPath: config.gitPath } : {});
  if (location === undefined) {
    throw new StartupError(ExitCode.Config, 'git was not found; install git or set WIREBENCH_SERVER_GIT_PATH');
  }
  return new GitCli(location, { hooksDir: join(config.dataDir, NO_HOOKS_DIR) });
}

/** How a failed migration reads on stderr: a WirebenchError (e.g. `server-schema-too-new`) keeps its code. */
function migrationFailure(error: unknown): string {
  if (error instanceof WirebenchError) return `${error.code}: ${error.message}`;
  return `migration failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * The host's migrations and each module's, merged in version order. No single folder has to be
 * contiguous — once identity takes 0002, a later host migration is 0005 — so contiguity from 0001
 * (and uniqueness) is checked on the combined, sorted list. `hostDir` exists for tests.
 */
export async function allMigrations(
  modules: readonly ServerModule[],
  hostDir: string = MIGRATIONS_DIR,
): Promise<readonly Migration[]> {
  const moduleDirs = modules.flatMap((m) => (m.migrationsDir !== undefined ? [m.migrationsDir] : []));
  let perFolder: (readonly Migration[])[];
  try {
    perFolder = await Promise.all([
      loadMigrations(hostDir, { contiguous: false }),
      ...moduleDirs.map((dir) => loadMigrations(dir, { contiguous: false })),
    ]);
  } catch (error) {
    throw new StartupError(ExitCode.Migration, error instanceof Error ? error.message : String(error));
  }
  const combined = perFolder.flat().sort((a, b) => a.version - b.version);
  for (const [index, migration] of combined.entries()) {
    if (index > 0 && combined[index - 1]!.version === migration.version) {
      throw new StartupError(ExitCode.Migration, `duplicate migration version ${migration.version} across modules`);
    }
    if (migration.version !== index + 1) {
      throw new StartupError(
        ExitCode.Migration,
        `migration versions across modules are not contiguous at ${migration.version}`,
      );
    }
  }
  return combined;
}

export async function runMigrate(
  env: NodeJS.ProcessEnv,
  io: ServerIo,
  check: boolean,
  modules: readonly ServerModule[] = [],
): Promise<number> {
  let config: ServerConfig;
  try {
    config = configFrom(env, io);
  } catch (error) {
    if (error instanceof StartupError) {
      io.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    throw error;
  }
  const db = createDatabase(config.databaseUrl);
  try {
    const migrations = await allMigrations(modules);
    if (check) {
      const pending = await pendingMigrations(db, migrations);
      io.stdout.write(
        pending.length === 0
          ? 'migrations: up to date\n'
          : `migrations: ${pending.length} pending (${pending.map((m) => m.version).join(', ')})\n`,
      );
      return pending.length === 0 ? ExitCode.Ok : ExitCode.Pending;
    }
    const { applied } = await migrate(db, migrations);
    io.stdout.write(
      applied.length === 0 ? 'migrations: nothing to apply\n' : `migrations: applied ${applied.join(', ')}\n`,
    );
    return ExitCode.Ok;
  } catch (error) {
    io.stderr.write(`${error instanceof StartupError ? error.message : migrationFailure(error)}\n`);
    return ExitCode.Migration;
  } finally {
    await db.close();
  }
}

export async function startServer(
  env: NodeJS.ProcessEnv,
  io: ServerIo,
  options: StartOptions = {},
): Promise<RunningServer> {
  const modules = options.modules ?? [];
  const exit = options.exit ?? ((code: number) => process.exit(code));
  const config = configFrom(env, io);
  const git = await locateGit(config);
  const db = createDatabase(config.databaseUrl);
  try {
    await migrate(db, await allMigrations(modules));
  } catch (error) {
    await db.close();
    if (error instanceof StartupError) throw error;
    throw new StartupError(ExitCode.Migration, migrationFailure(error));
  }
  try {
    await RepoStore.prepare(config.dataDir);
    for (const sub of ['repos', 'tmp']) {
      await access(join(config.dataDir, sub), constants.W_OK);
    }
  } catch {
    await db.close();
    throw new StartupError(ExitCode.Config, `data directory ${config.dataDir} is not writable`);
  }
  const repos = new RepoStore({ git, dataDir: config.dataDir });
  const ctx: ServerContext = {
    config,
    db,
    repos,
    git,
    log: undefined as unknown as ServerContext['log'], // buildServer replaces it with the app's logger
    meta: new MetaRegistry(),
    events: new ServerEvents(),
  };
  let app: FastifyInstance;
  try {
    app = await buildServer(ctx, { modules });
  } catch (error) {
    await db.close(); // a module that fails to register must not leave the pool holding the process open
    throw error;
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    await db.close();
    const code = (error as { readonly code?: unknown }).code;
    throw new StartupError(
      ExitCode.Config,
      `cannot listen on ${config.host}:${config.port}${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  app.log.info({ publicUrl: config.publicUrl, port, modules: modules.map((m) => m.name) }, 'listening');

  const signals: EventEmitter = options.signals ?? process;
  let closing: Promise<void> | undefined;
  const close = (): Promise<void> => {
    closing ??= (async () => {
      // Spec §3.7: wait up to drainMs for in-flight requests, then close the pool and exit 0. At
      // the deadline the remaining connections are dropped so app.close() resolves. The shutdown
      // stays a normal one: only a second signal ends it with 130.
      const timer = setTimeout(() => app.server.closeAllConnections(), options.drainMs ?? 10_000);
      timer.unref();
      // Node's server.close() drops only the connections idle at that moment; a keep-alive
      // connection whose request was in flight turns idle afterwards and would hold the close
      // open until the keep-alive timeout. Sweeping idle connections while draining ends each one
      // as soon as its response is sent.
      const sweep = setInterval(() => app.server.closeIdleConnections(), 25);
      sweep.unref();
      try {
        await app.close(); // stops accepting and waits for in-flight requests
      } finally {
        clearInterval(sweep);
        clearTimeout(timer);
        for (const name of SIGNALS) signals.off(name, onSignal);
      }
      await db.close();
    })();
    return closing;
  };
  // `on`, not `once`: a second SIGTERM must reach this handler too, or the process would fall
  // back to the default action and die with 143 instead of the documented 130.
  function onSignal(): void {
    if (closing !== undefined) {
      exit(EXIT_INTERRUPTED);
      return;
    }
    void close();
  }
  for (const name of SIGNALS) signals.on(name, onSignal);
  return { app, ctx: { ...ctx, log: app.log }, port, close };
}
