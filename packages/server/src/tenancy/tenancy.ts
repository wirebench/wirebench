/**
 * `ctx.tenancy` (hosted edition spec §19.8 guard 2): the tenant databases and the job loop, the modules' only way
 * to the database.
 *
 * The tenant directory is not on it (Task 6 review m2): its `list()`, `get(id)` and `hosted()` hand out
 * branded scopes, which a module must only ever get from a request or the job loop. `directoryOf` gives it to
 * the files `check:tenant-scope` lets name it: the start-up, the resolver's registration and the admin
 * command line.
 */
import { WirebenchError } from '@wirebench/engine';
import type { FastifyBaseLogger } from 'fastify';
import { announce, remote, type ServerHooks } from '../context.js';
import type { Database } from '../db/querier.js';
import type { BusEvents } from '../operations/bus.js';
import type { Querier } from '../db/querier.js';
import { TenantAdmin, TenantDirectory, type NewTenant, type TenantRow } from './directory.js';
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
  /**
   * Runs `listener` with the ids of every tenant that serves nothing now, suspended or deleting (spec §22.7), after
   * each read of the hosted tenant map that succeeded: a write here, another instance's `tenantsChanged`, a bus that
   * listens again after a loss, or the poll (review I1: the map is already the new one when it runs, so no socket
   * upgraded later is let through by a stale one). What the live hub, the host instances and the terminal shares
   * close that tenant's sockets, hosts and shares by, on every instance. Only told when there is at least one such
   * tenant. Ids, never scopes.
   */
  onTenantsStopped(listener: (tenantIds: ReadonlySet<string>) => void): void;
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
/** Each tenancy's {@link Tenancy.onTenantsStopped} listeners, which {@link tellTenantsStopped} runs. */
const stoppedListenersOf = new WeakMap<Tenancy, ((tenantIds: ReadonlySet<string>) => void)[]>();

export function createTenancy(db: Database, options: TenancyOptions = {}): Tenancy {
  const factory = tenantDbFactory(db, options);
  const keys = new TenantKeys(db, options.keyRoot);
  const directory = new TenantDirectory(db, keys);
  // A tenant written in this process: whatever key the cache holds for it may be stale (spec §19.7).
  directory.onChange(() => {
    keys.invalidate();
  });
  const stoppedListeners: ((tenantIds: ReadonlySet<string>) => void)[] = [];
  const tenancy: Tenancy = {
    db: factory,
    onTenantsStopped: (listener) => {
      stoppedListeners.push(listener);
    },
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
  stoppedListenersOf.set(tenancy, stoppedListeners);
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
 * The tenant map's own listeners are `server.ts`'s, where the resolver is made, and so is what tells
 * {@link Tenancy.onTenantsStopped}'s listeners: each read of the map. Idempotent per `tenancy`.
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
    if (!reconnected) return;
    keys.invalidate();
  });
}

/**
 * Tells `tenancy`'s {@link Tenancy.onTenantsStopped} listeners that the tenants in `tenantIds` serve nothing now (spec
 * §22.7): what the hosted resolver's reloads run on every instance, the writing one included. A listener that throws
 * is logged, and the rest still run.
 */
export function tellTenantsStopped(
  tenancy: Tenancy,
  tenantIds: ReadonlySet<string>,
  log: Pick<FastifyBaseLogger, 'warn'>,
): void {
  if (tenantIds.size === 0) return;
  for (const listener of stoppedListenersOf.get(tenancy) ?? []) {
    try {
      listener(tenantIds);
    } catch (error) {
      log.warn({ err: error }, "a stopped tenant's sockets could not all be closed");
    }
  }
}

/** The directory behind `tenancy`; only the files `check:tenant-scope` names may call it. */
export function directoryOf(tenancy: Tenancy): TenantDirectory {
  const directory = directories.get(tenancy);
  if (directory === undefined) throw new WirebenchError('tenancy-not-loaded', 'this tenancy has no directory');
  return directory;
}

/**
 * What the custom-domains module calls after a unit that held, released or made live a tenant's custom name commits
 * (hosted edition spec §23.5): the directory's change, which reloads this process's tenant map and, through
 * {@link shareTenancyCaches}, announces `tenantsChanged`, so every instance's map picks the name up or drops it. It
 * writes nothing and names no tenant: the map is read again whole.
 */
export function tenantHostsChanged(tenancy: Tenancy): void {
  directoryOf(tenancy).changed();
}

/**
 * Whether `scope` is the default tenant: a predicate, never a scope, so a module that needs to tell it apart
 * (the audit chain's configured key, spec §19.7) gets no way to reach it. Needs the directory loaded.
 */
export function isDefaultTenant(tenancy: Tenancy, scope: TenantScope): boolean {
  return directoryOf(tenancy).isDefault(scope);
}

/**
 * What the control plane writes the tenants with (hosted edition spec §22.2): `TenantAdmin.create` on its own control
 * transaction, the scope of a tenant it changed (for that tenant's audit unit), and the directory's change, which
 * reloads this process's map, drops its data keys and, through {@link shareTenancyCaches}, announces
 * `tenantsChanged` on the bus. `check:tenant-scope` lets only `control-plane/tenants.ts` name it, so no module can
 * create a tenant or tell the directory it changed.
 */
export interface TenantWrites {
  /** A new tenant and its data key, inserted on `tx`; nothing is told until {@link TenantWrites.changed}. */
  create(tx: Querier, input: NewTenant): Promise<TenantRow & { readonly scope: TenantScope }>;
  /** The tenant with this id, whatever its status; `undefined` when its row is gone. */
  scope(id: string): Promise<TenantScope | undefined>;
  /** After the transaction committed: this process's tenant listeners, and the bus. */
  changed(): void;
}

export function tenantWritesOf(tenancy: Tenancy): TenantWrites {
  const directory = directoryOf(tenancy);
  return {
    create: (tx, input) => new TenantAdmin(tx, directory, { announce: false }).create(input),
    scope: async (id) => (await directory.get(id))?.scope,
    changed: () => {
      directory.changed();
    },
  };
}
