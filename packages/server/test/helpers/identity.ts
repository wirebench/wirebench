import { join } from 'node:path';
import { directoryOf } from '../../src/tenancy/tenancy.js';
import type { FastifyInstance, RouteOptions } from 'fastify';
import type { GitCli } from '@wirebench/engine';
import { loadConfig, type ServerConfig } from '../../src/config.js';
import type { ServerContext, ServerHooks, ServerModule } from '../../src/context.js';
import { openControlDb } from '../../src/control-plane/control-db.js';
import { withControlPool } from '../../src/control-plane/module.js';
import { identityModule } from '../../src/identity/module.js';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { hashPassword } from '../../src/identity/passwords.js';
import * as repo from '../../src/identity/repo.js';
import { mintToken, newId } from '../../src/identity/tokens.js';
import { createLockPool, type LockPool } from '../../src/db/pool.js';
import { DatabaseRepoLock, guardGit, REPO_LOCK_POOL_MAX, REPO_LOCK_WAIT_MS } from '../../src/operations/repo-lock.js';
import { NO_HOOKS_DIR, RepoStore } from '../../src/repos/repo-store.js';
import { buildServer } from '../../src/server.js';
import type { TenantResolver } from '../../src/tenancy/resolve.js';
import type { TenantDb } from '../../src/tenancy/tenant-db.js';
import { testContext } from './context.js';
import { loggedTenancy, type StatementLog } from './tenancy.js';
import { testDatabase } from './database.js';
import { mkTempDir, removeTempDir, testGit } from './git.js';

export interface TestClock {
  now: Date;
  set(at: Date): void;
  advance(ms: number): void;
}

export interface IdentityHarness {
  readonly app: FastifyInstance;
  readonly db: Awaited<ReturnType<typeof testDatabase>>;
  readonly clock: TestClock;
  /** The context's hooks, to register an `invitationAccepted` probe. */
  readonly hooks: ServerHooks;
  /** A real repository store over `dataDir`: teams-access creates repositories through it. */
  readonly repos: RepoStore;
  readonly dataDir: string;
  /** The shared context, for a test that calls a module's functions directly (the sweep). */
  readonly ctx: ServerContext;
  /** The default tenant's database: what a test writes fixtures through, as identity's repository needs. */
  readonly tdb: TenantDb;
  /** Every statement sent through `ctx.tenancy`, with the tenant its unit set first; `expectAllScoped` reads this. */
  readonly statements: StatementLog;
  close(): Promise<void>;
}

/** Every way a `redirect_to` could leave the origin, including dot-segments that collapse into `//host`. */
export const EVIL_REDIRECTS = [
  'https://evil.test/',
  '//evil.test/x',
  '/\\evil.test',
  '/a\\..\\/evil.test',
  '/..//evil.test/x',
  '/%2e%2e//evil.test',
  '/a/..//evil.test',
  '/./../..//evil.test',
  'javascript:alert(1)',
  'w/1',
  '',
];

export const OIDC_ENV = {
  WIREBENCH_SERVER_OIDC_ISSUER: 'https://idp.test',
  WIREBENCH_SERVER_OIDC_CLIENT_ID: 'wirebench',
  WIREBENCH_SERVER_OIDC_CLIENT_SECRET: 'client-secret',
};

/**
 * A server with the identity module (and any `modules` after it) over a fresh schema, an
 * injectable clock and no sweep timer. `env` overrides the configuration; pass `OIDC_ENV` plus a
 * `provider` to turn OIDC on without discovery.
 */
export async function identityHarness(
  options: {
    readonly env?: Record<string, string>;
    readonly provider?: OidcProvider;
    readonly modules?: readonly ServerModule[] | ((clock: TestClock) => readonly ServerModule[]);
    /** Overrides the repository store's git client — a test forcing `RepoStore.create` to fail. */
    readonly git?: GitCli;
    /** Where the server's log lines go, for a test reading them. */
    readonly logStream?: NodeJS.WritableStream;
    /**
     * A schema an earlier harness used, to start the server again over the same data (a restart).
     * The harness leaves it open on `close`; its owner closes it.
     */
    readonly db?: Awaited<ReturnType<typeof testDatabase>>;
    /** A data directory of the test's own (a migrated fixture's, say), left in place on `close`. */
    readonly dataDir?: string;
    /** Changes the loaded configuration: a hosted one, built in part rather than from a whole environment. */
    readonly configure?: (config: ServerConfig) => ServerConfig;
    /** Runs after the directory loaded and before the server is built: tenants the hosted map starts with. */
    /** The hosted tenant map, for a test that changes a tenant behind the directory's back. */
    readonly onTenantResolver?: (resolver: TenantResolver) => void;
    /** Every route the server registers (`buildServer`'s `onRoute`). */
    readonly onRoute?: (route: RouteOptions) => void;
    readonly beforeBuild?: (db: Awaited<ReturnType<typeof testDatabase>>, ctx: ServerContext) => Promise<void>;
    /** This process's instance and its bus's signals, for a test of two servers on one schema (spec §20.3). */
    readonly instance?: ServerContext['instance'];
    readonly bus?: ServerContext['bus'];
    /** The share relay of a `multi` server (spec §20.6). */
    readonly relay?: ServerContext['relay'];
    /** The server's instruments, for a test that collects what was recorded (spec §20.8). */
    readonly metrics?: ServerContext['metrics'];
    /**
     * Hands the control-plane module a control pool on this schema (spec §22.2), as `serve.ts` does in hosted mode.
     * It connects lazily, and nothing is granted to the control role until a test runs `ensureControlRole`.
     */
    readonly control?: boolean;
    /**
     * The database repository lock the server always has (spec §20.4), on a lock pool of the harness's own, with
     * the git clients guarded as the server's are; `waitMs` shortens the 30 s wait. Off by default.
     */
    readonly repoLock?: { readonly waitMs?: number };
  } = {},
): Promise<IdentityHarness> {
  const db = options.db ?? (await testDatabase());
  const dataDir = options.dataDir ?? (await mkTempDir());
  const clock: TestClock = {
    now: new Date('2026-09-24T12:00:00.000Z'),
    set(at) {
      this.now = at;
    },
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const loaded = loadConfig(
    {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      ...options.env,
    },
    '0.0.0-test',
  );
  const config = options.configure?.(loaded) ?? loaded;
  const identity = identityModule({
    now: () => clock.now,
    sweepIntervalMs: 0,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  });
  const extra = typeof options.modules === 'function' ? options.modules(clock) : (options.modules ?? []);
  const modules = [identity, ...extra];
  // `testDatabase` has run every built-in module's migrations as the owner, whichever modules this suite
  // registers: versions are checked for contiguity across modules, so a partial set would leave a gap.
  // Only `modules` get routes and hooks.
  await RepoStore.prepare(dataDir);
  let lockPool: LockPool | undefined;
  if (options.repoLock !== undefined) {
    lockPool = createLockPool(db.url, {
      max: REPO_LOCK_POOL_MAX,
      applicationName: 'wirebench-server-repo-lock',
      waitMs: options.repoLock.waitMs ?? REPO_LOCK_WAIT_MS,
    });
  }
  const guard = (git: GitCli): GitCli => (lockPool === undefined ? git : guardGit(git));
  const repos = new RepoStore({
    git: guard(options.git ?? testGit(join(dataDir, NO_HOOKS_DIR))),
    dataDir,
    ...(lockPool !== undefined ? { lock: new DatabaseRepoLock({ pool: lockPool }) } : {}),
  });
  // R13: ctx.git (and the commit store's ctx.git.withPlumbing()) gets the same hermetic client as the
  // repository store, so no developer gitconfig or hook reaches a server test. `options.git` still
  // overrides only the store, for tests that force RepoStore.create to fail.
  const { tenancy, log: statements } = loggedTenancy(db, config.secretsKey);
  const control = options.control === true ? openControlDb(db.controlUrl) : undefined;
  const ctx = await testContext({
    dataDir,
    db,
    config,
    repos,
    git: guard(testGit(join(dataDir, NO_HOOKS_DIR))),
    tenancy,
    ...(options.instance !== undefined ? { instance: options.instance } : {}),
    ...(options.bus !== undefined ? { bus: options.bus } : {}),
    ...(options.relay !== undefined ? { relay: options.relay } : {}),
    ...(options.metrics !== undefined ? { metrics: options.metrics } : {}),
  });
  const directory = directoryOf(ctx.tenancy);
  await directory.load();
  await options.beforeBuild?.(db, ctx);
  const app = await buildServer(ctx, {
    // The pool goes to the control-plane module's factory, as serve.ts hands it: never on the context.
    modules: withControlPool(modules, control, config),
    ...(options.logStream !== undefined ? { logStream: options.logStream } : {}),
    ...(options.onTenantResolver !== undefined ? { onTenantResolver: options.onTenantResolver } : {}),
    ...(options.onRoute !== undefined ? { onRoute: options.onRoute } : {}),
  });
  return {
    app,
    db,
    clock,
    hooks: ctx.hooks,
    repos,
    dataDir,
    ctx,
    tdb: ctx.tenancy.db(directory.defaultScope()),
    statements,
    close: async () => {
      await app.close();
      await control?.close();
      await lockPool?.close();
      if (options.db === undefined) await db.close();
      if (options.dataDir === undefined) await removeTempDir(dataDir);
    },
  };
}

export interface SignedInUser {
  readonly user: repo.UserRow;
  readonly token: string;
  readonly tokenId: string;
  readonly headers: { readonly authorization: string };
}

/** A user written straight into the tables, with a credential when `password` is given and one device token. */
export async function signedInUser(
  harness: IdentityHarness,
  input: {
    readonly email: string;
    readonly password?: string;
    readonly serverAdmin?: boolean;
    readonly disabled?: boolean;
    readonly deviceName?: string;
    /** `browser` for a cookie session (hosted spec §17.2); a desktop device token by default. */
    readonly kind?: repo.TokenKind;
    /** The tenant the user is in; the default tenant's by default. */
    readonly tdb?: TenantDb;
  },
): Promise<SignedInUser> {
  const at = harness.clock.now;
  const tdb = input.tdb ?? harness.tdb;
  const user = await repo.insertUser(tdb, {
    id: newId(),
    email: input.email,
    displayName: input.email.split('@')[0] ?? input.email,
    serverAdmin: input.serverAdmin ?? false,
    at,
  });
  if (input.password !== undefined) await repo.upsertCredential(tdb, user.id, await hashPassword(input.password), at);
  if (input.disabled === true) await repo.setDisabled(tdb, user.id, at);
  const { token, hash } = mintToken();
  const tokenId = newId();
  await repo.insertToken(tdb, {
    id: tokenId,
    userId: user.id,
    tokenHash: hash,
    deviceName: input.deviceName ?? 'test device',
    ...(input.kind !== undefined ? { kind: input.kind } : {}),
    at,
  });
  return { user, token, tokenId, headers: { authorization: `Bearer ${token}` } };
}
