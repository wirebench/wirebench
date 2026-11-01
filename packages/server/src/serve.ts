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
import {
  ConfigError,
  egressPolicyOf,
  forgetDatabaseUrls,
  loadConfig,
  migrationUrlOf,
  type ServerConfig,
} from './config.js';
import { MetaRegistry, permissiveLicense, serverHooks, type ServerContext, type ServerModule } from './context.js';
import type { Database } from './db/querier.js';
import { loadMigrations, migrate, MIGRATIONS_DIR, pendingMigrations, type Migration } from './db/migrate.js';
import { createDatabase } from './db/pool.js';
import { checkAppRole, checkPostgresVersion } from './tenancy/checks.js';
import { TENANCY_MIGRATIONS_DIR } from './tenancy/migrations.js';
import { RunningLock, type RunningLockOptions } from './tenancy/running-lock.js';
import { operatorPublicUrl } from './tenancy/urls.js';
import { environmentKeyRoot } from './tenancy/keys.js';
import { createTenancy, directoryOf } from './tenancy/tenancy.js';
import { ensureAppRole, roleMode } from './tenancy/roles.js';
import { ExitCode, packageVersion, type ServerIo } from './io.js';
import { NO_HOOKS_DIR, RepoStore } from './repos/repo-store.js';
import { checkNothingLeftBehind, readTenancyStep, runTenancySteps } from './tenancy/file-step.js';
import { TENANTS_DIR } from './tenancy/paths.js';
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
  /** The server's own pool, which no module sees (spec §19.8 guard 2): for the start-up's tests. */
  readonly db: Database;
  readonly port: number;
  /** Stops accepting, drains in-flight requests and queued repository work, closes the pool. Idempotent. */
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
  /** Where the server's log lines go instead of stdout; tests read the start-up warnings from it. */
  readonly logStream?: NodeJS.WritableStream;
  /**
   * Test only: start without migration 0020, which a test's partial module list leaves out. Production lists
   * always reach it, and a server without it has no tenants, so it refuses.
   */
  readonly allowNoTenants?: boolean;
  /** How a lost running lock is retried (spec §19.10); tests shorten it. */
  readonly runningLock?: Pick<RunningLockOptions, 'retakeWindowMs' | 'retryDelayMs' | 'heartbeatMs' | 'open'>;
}

/**
 * Loads the configuration, then deletes the database URLs from `process.env`: `GitCli` always
 * spreads `process.env` into git's environment (an `env` option can only add to it), so leaving
 * the variables there would hand the connection strings to every git child process.
 */
function configFrom(env: NodeJS.ProcessEnv, io: ServerIo): ServerConfig {
  try {
    const config = loadConfig(env, packageVersion());
    forgetDatabaseUrls();
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

/**
 * `roleMode` (spec §19.4), with its refusal of a keyword-form connection string as a configuration error.
 * One role migrates and queries, exactly as before slice 4; two have the owner migrate and grant.
 */
function roleModeOf(config: ServerConfig): 'one-role' | 'two-roles' {
  try {
    return roleMode(config);
  } catch (error) {
    if (error instanceof WirebenchError) throw new StartupError(ExitCode.Config, `${error.code}: ${error.message}`);
    throw error;
  }
}

/**
 * The app pool's first query, with a refused password named for what it most likely is: an app role that
 * already existed with another password, which `ensureAppRole` leaves alone (spec §19.4 only creates).
 */
async function checkAppSignIn(db: Database, appUrl: string): Promise<void> {
  try {
    await db.query('select 1');
  } catch (error) {
    if ((error as { readonly code?: unknown }).code !== '28P01') throw error;
    const role = new URL(appUrl).username;
    throw new StartupError(
      ExitCode.Config,
      `the app role ${decodeURIComponent(role)} refused the password in WIREBENCH_SERVER_DATABASE_URL; it existed already, and its password is not changed at start-up: set it on the role as the owner (\\password in psql), or fix the URL`,
    );
  }
}

/**
 * As the owner: the pending migrations, then the app role and its grants (`ensureAppRole`), every time,
 * so a table a migration just created is granted before the app role connects.
 */
async function migrateAndGrant(owner: Database, appUrl: string, migrations: readonly Migration[]): Promise<number[]> {
  const { applied } = await migrate(owner, migrations);
  await ensureAppRole(owner, appUrl);
  return applied;
}

/** How a failed migration reads on stderr: a WirebenchError (e.g. `server-schema-too-new`) keeps its code. */
function migrationFailure(error: unknown): string {
  if (error instanceof WirebenchError) return `${error.code}: ${error.message}`;
  return `migration failed: ${error instanceof Error ? error.message : String(error)}`;
}

/**
 * The host's migrations and each module's, merged in version order. No single folder has to be
 * contiguous — once identity takes 0002, a later host migration is 0005 — so contiguity from 0001
 * (and uniqueness) is checked on the combined, sorted list. `hostDir` and `tenancyDir` exist for tests.
 */
export async function allMigrations(
  modules: readonly ServerModule[],
  hostDir: string = MIGRATIONS_DIR,
  tenancyDir: string = TENANCY_MIGRATIONS_DIR,
): Promise<readonly Migration[]> {
  const moduleDirs = modules.flatMap((m) =>
    m.migrationsDir === undefined ? [] : typeof m.migrationsDir === 'string' ? [m.migrationsDir] : [...m.migrationsDir],
  );
  let perFolder: (readonly Migration[])[];
  let tenancy: readonly Migration[];
  try {
    [tenancy, ...perFolder] = await Promise.all([
      loadMigrations(tenancyDir, { contiguous: false }),
      loadMigrations(hostDir, { contiguous: false }),
      ...moduleDirs.map((dir) => loadMigrations(dir, { contiguous: false })),
    ]);
  } catch (error) {
    throw new StartupError(ExitCode.Migration, error instanceof Error ? error.message : String(error));
  }
  // The tenancy migrations scope every module's tables, so they join only a list that reaches the version
  // before them: every production list does, and a test's partial module set stops short of them.
  const modular = perFolder.flat();
  const before = (tenancy[0]?.version ?? 1) - 1;
  const combined = [...modular, ...(modular.some((m) => m.version === before) ? tenancy : [])].sort(
    (a, b) => a.version - b.version,
  );
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

/** Names, never content: the state files the move's scan skipped for their size. */
const skippedNote =
  (io: ServerIo) =>
  (names: readonly string[]): void => {
    io.stderr.write(
      `data directory: ${String(names.length)} state files over 8 MiB were not scanned for the old checkouts path: ` +
        `${names.slice(0, 20).join(', ')}${names.length > 20 ? ', …' : ''}\n`,
    );
  };

const exists = (path: string): Promise<boolean> =>
  access(path).then(
    () => true,
    () => false,
  );

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
  let mode: 'one-role' | 'two-roles';
  try {
    mode = roleModeOf(config);
  } catch (error) {
    if (!(error instanceof StartupError)) throw error;
    io.stderr.write(`${error.message}\n`);
    return error.exitCode;
  }
  const db = createDatabase(migrationUrlOf(config), { applicationName: 'wirebench-migrate' });
  try {
    // Before anything pending is read or run: 0020's composite keys need PostgreSQL 15 (spec §19.1).
    try {
      await checkPostgresVersion(db);
    } catch (error) {
      if (!(error instanceof WirebenchError) || error.code !== 'server-postgres-too-old') throw error;
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return ExitCode.Config;
    }
    const migrations = await allMigrations(modules);
    // Before anything is migrated: a data directory left behind by a move made elsewhere changes nothing here.
    try {
      await checkNothingLeftBehind(db, config.dataDir);
    } catch (error) {
      if (!(error instanceof WirebenchError)) throw error;
      io.stderr.write(`${error.code}: ${error.message}\n`);
      return check ? ExitCode.Pending : ExitCode.Config;
    }
    if (check) {
      const pending = await pendingMigrations(db, migrations);
      io.stdout.write(
        pending.length === 0
          ? 'migrations: up to date\n'
          : `migrations: ${pending.length} pending (${pending.map((m) => m.version).join(', ')})\n`,
      );
      // Spec §19.10: the data directory's move is part of the upgrade, so a step short of `done` is pending too.
      const state = await readTenancyStep(db);
      const stepPending = state !== undefined && state.step !== 'done';
      if (stepPending) io.stdout.write(`data directory: the move to the new layout is pending (step ${state.step})\n`);
      return pending.length === 0 && !stepPending ? ExitCode.Ok : ExitCode.Pending;
    }
    const applied =
      mode === 'two-roles'
        ? await migrateAndGrant(db, config.databaseUrl, migrations)
        : (await migrate(db, migrations)).applied;
    io.stdout.write(
      applied.length === 0 ? 'migrations: nothing to apply\n' : `migrations: applied ${applied.join(', ')}\n`,
    );
    // The file step runs from here too (spec §19.10), so an upgrade can be finished before the server starts. A
    // `migrate` run where the data directory is not mounted (a job that only applies the schema) leaves the move
    // to the server's next start, as before this step existed.
    if (!(await exists(config.dataDir))) {
      io.stdout.write(`data directory: ${config.dataDir} not found here; the server moves it at its next start\n`);
      return ExitCode.Ok;
    }
    try {
      const step = await runTenancySteps(db, config.dataDir, { onSkipped: skippedNote(io) });
      if (step !== undefined)
        io.stdout.write(`data directory: ${step === 'done' ? 'in the new layout' : `step ${step}`}\n`);
    } catch (error) {
      if (!(error instanceof WirebenchError)) throw error;
      io.stderr.write(`${error.code}: ${error.message}\n`);
      // The image's own empty /data, with the volume not mounted here: the schema is migrated, and the server moves
      // its real data directory at its next start (C1 of the Task 22 review).
      if (error.code === 'tenancy-data-dir-empty') return ExitCode.Ok;
      return ExitCode.Config;
    }
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
  // With an owner of its own (spec §19.4), the server migrates and grants as the owner, then connects as
  // the app role. With one role it migrates as that role: over the migration URL when one is set apart (a
  // direct connection beside a pooler, say), as `migrate` does, and otherwise over the one pool, as always.
  const mode = roleModeOf(config);
  const migrationUrl = migrationUrlOf(config);
  // The pool's errors are logged once the logger exists; a connection failing before then fails a query too.
  const dbLog: { warn?: (error: Error) => void } = {};
  const db = createDatabase(config.databaseUrl, { onError: (error) => dbLog.warn?.(error) });
  // Set once the server can stop itself. Losing the lock before then is recorded, and fails the start.
  const lockLost: { stop?: (error: Error) => void; early?: Error } = {};
  const lockOptions = {
    ...options.runningLock,
    onLost: (error: Error) => {
      if (lockLost.stop !== undefined) lockLost.stop(error);
      else lockLost.early ??= error;
    },
  };
  // Held for the life of the process; a revert's exclusive try fails while it is (spec §19.10). Taken before
  // migrating, so a start during a revert touches nothing, and on the migration URL, which is always a direct
  // connection: a session-level advisory lock means nothing behind a transaction pooler, which the app URL may
  // be (owner ruling, 2026-10-30). With one URL it is that URL, as before.
  let runningLock: RunningLock | undefined;
  const fail = async (error: StartupError): Promise<never> => {
    await runningLock?.release();
    await db.close();
    throw error;
  };
  try {
    const migrations = await allMigrations(modules);
    // Before 0020, on the connection that migrates: its composite keys need PostgreSQL 15 (spec §19.1).
    if (migrationUrl === config.databaseUrl) {
      await checkPostgresVersion(db);
      runningLock = await RunningLock.acquire(migrationUrl, { ...lockOptions, label: 'the database connection' });
      await checkNothingLeftBehind(db, config.dataDir);
      await migrate(db, migrations);
    } else {
      const owner = createDatabase(migrationUrl);
      try {
        await checkPostgresVersion(owner);
        runningLock = await RunningLock.acquire(migrationUrl, { ...lockOptions, label: 'the migration connection' });
        // Before anything is migrated: the refusal then leaves the database as it was too.
        await checkNothingLeftBehind(owner, config.dataDir);
        if (mode === 'two-roles') await migrateAndGrant(owner, config.databaseUrl, migrations);
        else await migrate(owner, migrations);
      } finally {
        await owner.close();
      }
      if (mode === 'two-roles') await checkAppSignIn(db, config.databaseUrl);
    }
  } catch (error) {
    if (error instanceof StartupError) return fail(error);
    if (
      error instanceof WirebenchError &&
      (error.code === 'server-postgres-too-old' ||
        error.code === 'tenancy-reverting' ||
        error.code === 'tenancy-files-left-behind')
    ) {
      return fail(new StartupError(ExitCode.Config, `${error.code}: ${error.message}`));
    }
    return fail(new StartupError(ExitCode.Migration, migrationFailure(error)));
  }
  // Spec §19.10's order: the migrations, then the file step, then `prepare` and the writability check, so
  // `prepare` can never make an empty tenants/ tree beside a half-moved data directory.
  try {
    await runTenancySteps(db, config.dataDir, { onSkipped: skippedNote(io) });
  } catch (error) {
    if (error instanceof WirebenchError) {
      return fail(new StartupError(ExitCode.Config, `${error.code}: ${error.message}`));
    }
    // The errno code only: Node's message names a path under tenants/<id> (Task 22 review m2).
    const code = (error as NodeJS.ErrnoException | null)?.code ?? 'an unexpected error';
    return fail(new StartupError(ExitCode.Config, `data directory ${config.dataDir} could not be moved (${code})`));
  }
  try {
    await RepoStore.prepare(config.dataDir);
    // Spec §19.6: every repository, checkout and scratch file is under tenants/ now.
    await access(join(config.dataDir, TENANTS_DIR), constants.W_OK);
  } catch {
    return fail(new StartupError(ExitCode.Config, `data directory ${config.dataDir} is not writable`));
  }
  const warnings: { readonly message: string; readonly details: Record<string, unknown> }[] = [];
  // The root wraps each tenant's data key (spec §19.7); without it no key is made, and nothing is sealed.
  const tenancy = createTenancy(
    db,
    config.secretsKey !== undefined ? { keyRoot: environmentKeyRoot(config.secretsKey) } : {},
  );
  try {
    await checkAppRole(db, config.mode, (message, details) => warnings.push({ message, details }));
    // A module list that stops short of 0019 leaves 0020 out (`allMigrations`), and with it every tenant.
    if (!(await directoryOf(tenancy).load()) && options.allowNoTenants !== true) {
      return fail(new StartupError(ExitCode.Migration, 'migration 0020 is not applied: the server has no tenants'));
    }
  } catch (error) {
    if (error instanceof WirebenchError)
      return fail(new StartupError(ExitCode.Config, `${error.code}: ${error.message}`));
    return fail(new StartupError(ExitCode.Migration, migrationFailure(error)));
  }
  // Set by now: every path above that leaves it unset has thrown.
  const heldLock = runningLock;
  const lostDuringStart = (): StartupError =>
    new StartupError(
      ExitCode.Migration,
      `lost during start-up and could not be taken again: ${lockLost.early?.message ?? 'the server-running lock'}`,
    );
  const repos = new RepoStore({ git, dataDir: config.dataDir });
  const ctx: ServerContext = {
    config,
    tenancy,
    repos,
    git,
    log: undefined as unknown as ServerContext['log'], // buildServer replaces it with the app's logger
    meta: new MetaRegistry(),
    egress: egressPolicyOf(config),
    hooks: serverHooks(),
    license: permissiveLicense(),
  };
  let app: FastifyInstance;
  try {
    app = await buildServer(ctx, {
      modules,
      ...(options.logStream !== undefined ? { logStream: options.logStream } : {}),
    });
  } catch (error) {
    await heldLock.release();
    await db.close(); // a module that fails to register must not leave the pool holding the process open
    if (error instanceof StartupError) throw error;
    // Discovery against the IdP, a duplicate decorator, a bad route: all configuration-shaped
    // failures of a module's register(), reported as exit 2 with the module's own message.
    throw new StartupError(
      ExitCode.Config,
      `a module failed to register: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  dbLog.warn = (error) => {
    app.log.warn({ err: error }, 'a database connection failed');
  };
  for (const warning of warnings) app.log.warn(warning.details, warning.message);
  // Module registration can take seconds (OIDC discovery): a lock lost meanwhile means no listening at all.
  if (lockLost.early !== undefined) {
    await app.close();
    await heldLock.release();
    await db.close();
    throw lostDuringStart();
  }
  try {
    await app.listen({ host: config.host, port: config.port });
  } catch (error) {
    await app.close();
    await heldLock.release();
    await db.close();
    const code = (error as { readonly code?: unknown }).code;
    throw new StartupError(
      ExitCode.Config,
      `cannot listen on ${config.host}:${config.port}${typeof code === 'string' ? ` (${code})` : ''}`,
    );
  }
  const address = app.server.address();
  const port = typeof address === 'object' && address !== null ? address.port : config.port;
  app.log.info({ publicUrl: operatorPublicUrl(config), port, modules: modules.map((m) => m.name) }, 'listening');

  const signals: EventEmitter = options.signals ?? process;
  let closing: Promise<void> | undefined;
  /** `lost`: the lock is gone, so nothing more is served, and repository work is not waited for (spec §19.10). */
  const shutDown = (lost: boolean): Promise<void> => {
    closing ??= (async () => {
      // Spec §3.7: wait up to drainMs for in-flight requests, then close the pool and exit 0. At
      // the deadline the remaining connections are dropped so app.close() resolves. The shutdown
      // stays a normal one: only a second signal ends it with 130.
      if (lost) app.server.closeAllConnections();
      const timer = setTimeout(() => app.server.closeAllConnections(), lost ? 0 : (options.drainMs ?? 10_000));
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
      // Sync spec R11: a handler whose connection the deadline dropped still finishes its repository
      // work (a push looks up its author and writes commits), so the pool outlives that work. From
      // here on, new repository work is refused with server-shutting-down.
      if (!lost) await repos.drain();
      await heldLock.release();
      await db.close();
    })();
    return closing;
  };
  const close = (): Promise<void> => shutDown(false);
  // Without the lock a revert could start under this server, so it stops (spec §19.10).
  lockLost.stop = (error) => {
    app.log.error({ err: error }, 'the server-running lock was lost and could not be taken again; stopping');
    void shutDown(true)
      .catch((closeError: unknown) => {
        app.log.error({ err: closeError }, 'the server did not close cleanly after losing its lock');
      })
      .finally(() => {
        exit(ExitCode.Migration);
      });
  };
  // Lost between `listen` and here: stop now rather than serve without it.
  if (lockLost.early !== undefined) {
    await shutDown(true).catch(() => undefined);
    throw lostDuringStart();
  }
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
  return { app, ctx: { ...ctx, log: app.log }, db, port, close };
}
