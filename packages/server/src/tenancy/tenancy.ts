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
import type { Database } from '../db/querier.js';
import { TenantDirectory } from './directory.js';
import { forEachTenant, type JobOutcome, type JobPass } from './jobs.js';
import type { TenantScope } from './scope.js';
import { tenantDbFactory, type TenancyDbOptions, type TenantDbFactory, type TenantQuerier } from './tenant-db.js';

export interface Tenancy {
  readonly db: TenantDbFactory;
  /** One unit per tenant; see `jobs.ts`. `log` is the job's own logger. */
  forEachTenant(
    job: string,
    fn: (tx: TenantQuerier, scope: TenantScope) => Promise<JobOutcome>,
    log: Pick<FastifyBaseLogger, 'error'>,
  ): Promise<JobPass>;
  /** `/healthz`: whether the database answers `select 1`, which reads no table and needs no tenant. */
  reachable(): Promise<void>;
}

const directories = new WeakMap<Tenancy, TenantDirectory>();

export function createTenancy(db: Database, options: TenancyDbOptions = {}): Tenancy {
  const factory = tenantDbFactory(db, options);
  const directory = new TenantDirectory(db);
  const tenancy: Tenancy = {
    db: factory,
    forEachTenant: (job, fn, log) => forEachTenant({ directory, db: factory, log }, job, fn),
    reachable: async () => {
      await db.query('select 1');
    },
  };
  directories.set(tenancy, directory);
  return tenancy;
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
