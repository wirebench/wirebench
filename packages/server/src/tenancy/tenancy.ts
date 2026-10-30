/**
 * `ctx.tenancy` (hosted edition spec §19.8 guard 2): the tenant databases, the directory and the job loop.
 * It sits beside `ctx.db` until Task 17 takes `ctx.db` away from the modules.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { Database } from '../context.js';
import { TenantDirectory } from './directory.js';
import { forEachTenant, type JobPass } from './jobs.js';
import type { TenantScope } from './scope.js';
import { tenantDbFactory, type TenancyDbOptions, type TenantDbFactory, type TenantQuerier } from './tenant-db.js';

export interface Tenancy {
  readonly db: TenantDbFactory;
  readonly directory: TenantDirectory;
  /** One unit per tenant; see `jobs.ts`. `log` is the job's own logger. */
  forEachTenant(
    job: string,
    fn: (tx: TenantQuerier, scope: TenantScope) => Promise<void>,
    log: Pick<FastifyBaseLogger, 'error'>,
  ): Promise<JobPass>;
}

export function createTenancy(db: Database, options: TenancyDbOptions = {}): Tenancy {
  const factory = tenantDbFactory(db, options);
  const directory = new TenantDirectory(db);
  return {
    db: factory,
    directory,
    forEachTenant: (job, fn, log) => forEachTenant({ directory, db: factory, log }, job, fn),
  };
}
