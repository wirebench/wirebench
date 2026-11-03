/**
 * `ctx.tenancy` (hosted edition spec §19.8 guard 2): the tenant databases and the job loop, the modules' only way
 * to the database.
 *
 * The tenant directory is not on it (Task 6 review m2): its `list()`, `get(id)` and `resolvable()` hand out
 * branded scopes, which a module must only ever get from a request or the job loop. `directoryOf` gives it to
 * the files `check:tenant-scope` lets name it: the start-up, the resolver's registration and the admin
 * command line.
 */
import { WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { announce, remote, type ServerHooks } from '../context.js';
import type { Database } from '../db/querier.js';
import type { BusEvents } from '../operations/bus.js';
import { TenantDirectory } from './directory.js';
import { readTenancyStep } from './file-step.js';
import { forEachTenant, type JobOutcome, type JobPass } from './jobs.js';
import { TenantKeys, type KeyRoot } from './keys.js';
import type { TenantScope } from './scope.js';
import { tenantDbFactory, type TenancyDbOptions, type TenantDbFactory, type TenantQuerier } from './tenant-db.js';

export interface TenancyOptions extends TenancyDbOptions {
  /** The server root (`WIREBENCH_SERVER_SECRETS_KEY`, `environmentKeyRoot`); without it no tenant has a data key. */
  readonly keyRoot?: KeyRoot;
}

export interface Tenancy {
  readonly db: TenantDbFactory;
  /** One unit per tenant; see `jobs.ts`. `log` is the job's own logger. */
  forEachTenant(
    job: string,
    fn: (tx: TenantQuerier, scope: TenantScope) => Promise<JobOutcome>,
    log: Pick<FastifyBaseLogger, 'error'>,
  ): Promise<JobPass>;
  /**
   * One unit per tenant a hosted `Host` may name (spec §19.5: active, not the default), with its name: the entry's
   * lookup (spec §21.4). Otherwise as {@link forEachTenant}.
   */
  forEachResolvableTenant(
    job: string,
    fn: (tx: TenantQuerier, scope: TenantScope, name: string) => Promise<JobOutcome>,
    log: Pick<FastifyBaseLogger, 'error'>,
  ): Promise<JobPass>;
  /** `/healthz`: whether the database answers `select 1`, which reads no table and needs no tenant. */
  reachable(): Promise<void>;
  /**
   * `scope`'s data key (spec §19.7), made now if its row has none: what a server host's user keys derive from.
   *
   * @throws WirebenchError `tenancy-no-root` without the root; `tenancy-data-key-refused` when the stored key
   *   does not open for this tenant under it.
   */
  dataKey(scope: TenantScope): Promise<Buffer>;
  /**
   * Whether the self-hosted migration's steps are `done` (spec §19.10): host sockets are served only then. `true` on
   * a schema before `0020`, which has no step to wait for.
   */
  stepDone(): Promise<boolean>;
}

const directories = new WeakMap<Tenancy, TenantDirectory>();
const tenantKeys = new WeakMap<Tenancy, TenantKeys>();
const shared = new WeakSet<Tenancy>();

export function createTenancy(db: Database, options: TenancyOptions = {}): Tenancy {
  const factory = tenantDbFactory(db, options);
  const keys = new TenantKeys(db, options.keyRoot);
  const directory = new TenantDirectory(db, keys);
  // A tenant written in this process: whatever key the cache holds for it may be stale (spec §19.7).
  directory.onChange(() => {
    keys.invalidate();
  });
  const tenancy: Tenancy = {
    db: factory,
    forEachTenant: (job, fn, log) => forEachTenant({ directory, db: factory, log }, job, fn),
    forEachResolvableTenant: async (job, fn, log) => {
      const named = await directory.resolvableNamed();
      const names = new Map(named.map(({ scope, name }) => [scope.tenantId, name]));
      const list = (): Promise<TenantScope[]> => Promise.resolve(named.map(({ scope }) => scope));
      return forEachTenant({ directory: { list }, db: factory, log }, job, (tx, scope) =>
        fn(tx, scope, names.get(scope.tenantId) ?? scope.slug),
      );
    },
    reachable: async () => {
      await db.query('select 1');
    },
    dataKey: (scope) => keys.dataKey(scope.tenantId),
    stepDone: async () => {
      const state = await readTenancyStep(db);
      return state === undefined || state.step === 'done';
    },
  };
  directories.set(tenancy, directory);
  tenantKeys.set(tenancy, keys);
  return tenancy;
}

/**
 * Keeps this process's data-key cache in step with the other instances' (spec §20.3); `buildServer` calls it once.
 *
 * - A directory write here announces `tenantsChanged`, and a data key written here `tenantKeysChanged{tenantId}`.
 * - Their `remote` listeners (review M2) drop the keys another instance's write made stale: every one for
 *   `tenantsChanged` (as a write here does through the directory's own change), the one tenant's for
 *   `tenantKeysChanged`. A write here never reaches them: the directory's change already dropped the keys, and a key
 *   this process just wrote is the right one, which dropping would only make it read back.
 * - A bus that listens again after a loss may have missed either, so every key is dropped then too.
 *
 * The tenant map's own listeners are `server.ts`'s, where the resolver is made. Idempotent per `tenancy`.
 */
export function shareTenancyCaches(tenancy: Tenancy, hooks: ServerHooks, bus: BusEvents, log: FastifyBaseLogger): void {
  if (shared.has(tenancy)) return;
  shared.add(tenancy);
  const keys = tenantKeys.get(tenancy);
  if (keys === undefined) throw new WirebenchError('tenancy-not-loaded', 'this tenancy has no data keys');
  directoryOf(tenancy).onChange(() => {
    announce(hooks.tenantsChanged, {}, log);
  });
  keys.onWritten((tenantId) => {
    announce(hooks.tenantKeysChanged, { tenantId }, log);
  });
  hooks.tenantsChanged.push(
    remote(() => {
      keys.invalidate();
    }),
  );
  hooks.tenantKeysChanged.push(
    remote(({ tenantId }) => {
      keys.invalidate(tenantId);
    }),
  );
  bus.onListen(({ reconnected }) => {
    if (reconnected) keys.invalidate();
  });
}

/** The directory behind `tenancy`; only the files `check:tenant-scope` names may call it. */
export function directoryOf(tenancy: Tenancy): TenantDirectory {
  const directory = directories.get(tenancy);
  if (directory === undefined) throw new WirebenchError('tenancy-not-loaded', 'this tenancy has no directory');
  return directory;
}

/**
 * Whether `scope` is the default tenant: a predicate, never a scope, so a module that needs to tell it apart
 * (the audit chain's configured key, spec §19.7) gets no way to reach it. Needs the directory loaded.
 */
export function isDefaultTenant(tenancy: Tenancy, scope: TenantScope): boolean {
  return directoryOf(tenancy).isDefault(scope);
}
