import { join } from 'node:path';
import type { FastifyInstance } from 'fastify';
import { loadConfig } from '../../src/config.js';
import type { ServerHooks, ServerModule } from '../../src/context.js';
import { migrate } from '../../src/db/migrate.js';
import { identityModule } from '../../src/identity/module.js';
import type { OidcProvider } from '../../src/identity/oidc.js';
import { hashPassword } from '../../src/identity/passwords.js';
import * as repo from '../../src/identity/repo.js';
import { mintToken, newId } from '../../src/identity/tokens.js';
import { NO_HOOKS_DIR, RepoStore } from '../../src/repos/repo-store.js';
import { allMigrations } from '../../src/serve.js';
import { buildServer } from '../../src/server.js';
import { testContext } from './context.js';
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
  close(): Promise<void>;
}

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
  } = {},
): Promise<IdentityHarness> {
  const db = await testDatabase();
  const dataDir = await mkTempDir();
  const clock: TestClock = {
    now: new Date('2026-09-24T12:00:00.000Z'),
    set(at) {
      this.now = at;
    },
    advance(ms) {
      this.now = new Date(this.now.getTime() + ms);
    },
  };
  const config = loadConfig(
    {
      WIREBENCH_SERVER_DATABASE_URL: db.url,
      WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
      WIREBENCH_SERVER_DATA_DIR: dataDir,
      WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      ...options.env,
    },
    '0.0.0-test',
  );
  const identity = identityModule({
    now: () => clock.now,
    sweepIntervalMs: 0,
    ...(options.provider !== undefined ? { provider: options.provider } : {}),
  });
  const extra = typeof options.modules === 'function' ? options.modules(clock) : (options.modules ?? []);
  const modules = [identity, ...extra];
  await migrate(db, await allMigrations(modules));
  await RepoStore.prepare(dataDir);
  const repos = new RepoStore({ git: testGit(join(dataDir, NO_HOOKS_DIR)), dataDir });
  const ctx = await testContext({ dataDir, db, config, repos });
  const app = await buildServer(ctx, { modules });
  return {
    app,
    db,
    clock,
    hooks: ctx.hooks,
    repos,
    dataDir,
    close: async () => {
      await app.close();
      await db.close();
      await removeTempDir(dataDir);
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
  },
): Promise<SignedInUser> {
  const at = harness.clock.now;
  const user = await repo.insertUser(harness.db, {
    id: newId(),
    email: input.email,
    displayName: input.email.split('@')[0] ?? input.email,
    serverAdmin: input.serverAdmin ?? false,
    at,
  });
  if (input.password !== undefined)
    await repo.upsertCredential(harness.db, user.id, await hashPassword(input.password), at);
  if (input.disabled === true) await repo.setDisabled(harness.db, user.id, at);
  const { token, hash } = mintToken();
  const tokenId = newId();
  await repo.insertToken(harness.db, {
    id: tokenId,
    userId: user.id,
    tokenHash: hash,
    deviceName: input.deviceName ?? 'test device',
    at,
  });
  return { user, token, tokenId, headers: { authorization: `Bearer ${token}` } };
}
