import { randomUUID } from 'node:crypto';
import { GitCli, detectInText, findGit } from '@wirebench/engine';
import { egressPolicyOf, loadConfig } from '../../src/config.js';
import {
  MetaRegistry,
  permissiveLicense,
  serverHooks,
  type AuditInput,
  type ServerContext,
  type ServerHooks,
} from '../../src/context.js';
import type { Database } from '../../src/db/querier.js';
import { BusSignals } from '../../src/operations/bus.js';
import { noopMetrics } from '../../src/operations/metrics/sdk.js';
import type { ServerInstance } from '../../src/operations/instances.js';
import type { TenantQuerier } from '../../src/tenancy/tenant-db.js';
import type { RepoStore } from '../../src/repos/repo-store.js';
import type { TenantScope } from '../../src/tenancy/scope.js';
import { environmentKeyRoot } from '../../src/tenancy/keys.js';
import { createTenancy, directoryOf } from '../../src/tenancy/tenancy.js';
import { createTenantSettings } from '../../src/settings/service.js';

/** A database whose every query succeeds with no rows; `failing` flips `select 1` to a rejection. */
export function fakeDatabase(options: { failing?: boolean } = {}): Database {
  const querier = {
    query: (text: string) =>
      options.failing === true && text.trim().toLowerCase() === 'select 1'
        ? Promise.reject(new Error('connection refused'))
        : Promise.resolve({ rows: [], rowCount: 0 }),
  };
  return { ...querier, transaction: async (fn) => fn(querier), close: () => Promise.resolve() } as Database;
}

/** A test's `ctx.instance`, always ready until it drains. */
export type TestInstance = ServerInstance & {
  /** Runs every heartbeat listener; the test calls it, no timer does. */
  beat(): Promise<void>;
  /** The shutdown's first step (spec §20.5): every drain listener, once, as `serve.ts` runs it. */
  drain(): Promise<void>;
};

/** A test's `ctx.instance`: no row, a heartbeat that beats only when the test calls `beat`, and a drain likewise. */
export function testInstance(mode: ServerInstance['mode'] = 'single', holder: string = randomUUID()): TestInstance {
  const listeners: (() => Promise<void>)[] = [];
  const drainListeners: (() => Promise<void>)[] = [];
  let drained: Promise<void> | undefined;
  return {
    holder,
    mode,
    onBeat: (listener) => {
      listeners.push(listener);
    },
    beat: async () => {
      await Promise.all(listeners.map((listener) => listener()));
    },
    live: () => Promise.resolve([]),
    readiness: () => (drained === undefined ? 'ready' : 'draining'),
    get draining() {
      return drained !== undefined;
    },
    onDrain: (listener) => {
      drainListeners.push(listener);
    },
    drain: () => {
      drained ??= Promise.all(drainListeners.map((listener) => listener())).then(() => undefined);
      return drained;
    },
  };
}

/** The default tenant a context over no real database serves: its `request.tenant`, read by the moved modules. */
export const FAKE_DEFAULT_TENANT = { id: '00000000-0000-4000-8000-0000000000d0', slug: 'default' };

/** `fakeDatabase`, answering the tenant directory's start-up reads with {@link FAKE_DEFAULT_TENANT}. */
function fakeTenantsDatabase(): Database {
  const fake = fakeDatabase();
  const query = (text: string) => {
    if (text.includes("to_regclass('tenants')")) return Promise.resolve({ rows: [{ exists: true }], rowCount: 1 });
    if (text.includes('from server_identity s left join tenants t'))
      return Promise.resolve({ rows: [FAKE_DEFAULT_TENANT], rowCount: 1 });
    return fake.query(text);
  };
  return { ...fake, query } as Database;
}

/**
 * A context for a test. `db`, when given, is the database the context's tenancy runs over (a module sees no other);
 * without one, a fake answers the tenant directory's start-up reads.
 */
export async function testContext(
  overrides: Partial<ServerContext> & { dataDir?: string; db?: Database } = {},
): Promise<ServerContext> {
  const location = await findGit({});
  if (location === undefined) throw new Error('git is required for the server tests');
  const dataDir = overrides.dataDir ?? process.cwd();
  // Neither is a ServerContext field: `dataDir` picks the data directory, `db` the tenancy's database.
  const { dataDir: droppedDataDir, db: raw, ...rest } = overrides;
  void droppedDataDir;
  const config =
    rest.config ??
    loadConfig(
      {
        WIREBENCH_SERVER_DATABASE_URL: 'postgres://test',
        WIREBENCH_SERVER_PUBLIC_URL: 'https://wirebench.test',
        WIREBENCH_SERVER_DATA_DIR: dataDir,
        WIREBENCH_SERVER_LOG_LEVEL: 'fatal',
      },
      '0.0.0-test',
    );
  const base: Omit<ServerContext, 'settings'> & { settings?: ServerContext['settings'] } = {
    config,
    // `RepoStore` is a class with private fields now (Task 6); this fake only ever needs `path` and the
    // start-up sweep's `tmpDirs` from tests that don't exercise the real store, so it is cast through
    // `unknown` rather than built as a real `RepoStore` instance.
    repos: {
      path: (scope: TenantScope, id: string) => `${dataDir}/tenants/${scope.tenantId}/repos/${id}.git`,
      tmpDirs: () => Promise.resolve([]),
    } as unknown as RepoStore,
    git: new GitCli(location, { hooksDir: dataDir }),
    log: undefined as unknown as ServerContext['log'], // buildServer replaces it with the app's logger
    meta: new MetaRegistry(),
    egress: { denyPrivate: false },
    hooks: serverHooks(),
    instance: testInstance(),
    bus: new BusSignals(),
    metrics: noopMetrics().metrics,
    license: permissiveLicense(),
    ...rest,
    tenancy:
      rest.tenancy ??
      createTenancy(
        raw ?? fakeTenantsDatabase(),
        config.secretsKey !== undefined ? { keyRoot: environmentKeyRoot(config.secretsKey) } : {},
      ),
  };
  const context: ServerContext = {
    ...base,
    settings:
      base.settings ??
      createTenantSettings({ config: base.config, tenancy: base.tenancy, hooks: base.hooks, bus: base.bus }),
  };
  // With no real database, the directory is loaded here, so `request.tenant` names the fake default tenant;
  // over a real one, the caller loads it once the schema is migrated.
  if (rest.tenancy === undefined && raw === undefined) await directoryOf(context.tenancy).load();
  // Follows the config, as serve.ts builds it, unless the test passed its own.
  return rest.egress !== undefined ? context : { ...context, egress: egressPolicyOf(context.config) };
}

/** Wirebench's own token (`identity/tokens.ts` `TOKEN_PREFIX`) and license shapes, which the credential rules do not know. */
const WIREBENCH_SHAPES: readonly RegExp[] = [/wbs_[A-Za-z0-9_-]{20,}/, /wbl1\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]+/];

/**
 * Every audit row, serialised, scanned with the engine's secret rules (`detectInText`, the patterns the
 * secret-scanning spec defines) plus the two shapes above. Ids and commit hashes pass: the engine flags
 * high entropy only under a secret-sounding name, and a body name must be one of `SECRET_BODY_KEYS` exactly.
 */
export async function expectNoSecretsInAudit(db: TenantQuerier): Promise<void> {
  const rows = await db.query<Record<string, unknown>>('select actor_email, user_agent, details from audit_events');
  // A tenant with no rows (the wrong one, or a policy that hides them) would pass for nothing.
  if (rows.rows.length === 0) throw new Error('no audit rows to scan in this tenant');
  for (const row of rows.rows) {
    const text = JSON.stringify(row);
    // `tokenId` is the device-token row's id, never the token (§3.5: only its hash is stored); the engine's
    // entropy rule flags any high-entropy value under a name containing "token", so the id is dropped for that scan.
    const scanned = JSON.stringify(row, (key, value: unknown) => (key === 'tokenId' ? undefined : value));
    if (detectInText(scanned).length > 0 || WIREBENCH_SHAPES.some((shape) => shape.test(text))) {
      throw new Error(`audit row carries a secret-shaped value: ${text}`);
    }
  }
}

/** Pushes a hook that keeps every event; `events` is what a test asserts on. */
export function recordingAudit(hooks: ServerHooks): AuditInput[] {
  const events: AuditInput[] = [];
  hooks.audit.push((_tx, event) => {
    events.push(event);
    return Promise.resolve();
  });
  return events;
}
