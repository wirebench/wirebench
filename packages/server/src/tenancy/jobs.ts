/**
 * The job loop (hosted edition spec §19.8 guard 6): a background job runs once per tenant, each in its own
 * tenant unit. One tenant's failure is logged with the job's name and the tenant id, and the others still run.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { TenantDirectory } from './directory.js';
import type { TenantScope } from './scope.js';
import type { TenantDbFactory, TenantQuerier } from './tenant-db.js';

export interface JobLoopDeps {
  readonly directory: Pick<TenantDirectory, 'list'>;
  readonly db: TenantDbFactory;
  readonly log: Pick<FastifyBaseLogger, 'error'>;
}

export interface JobPass {
  readonly served: number;
  readonly failed: readonly string[];
}

export async function forEachTenant(
  deps: JobLoopDeps,
  job: string,
  fn: (tx: TenantQuerier, scope: TenantScope) => Promise<void>,
): Promise<JobPass> {
  const failed: string[] = [];
  let served = 0;
  for (const scope of await deps.directory.list()) {
    try {
      await deps.db(scope).transaction((tx) => fn(tx, scope));
      served++;
    } catch (error) {
      failed.push(scope.tenantId);
      deps.log.error({ err: error, job, tenantId: scope.tenantId }, 'a job failed for one tenant');
    }
  }
  return { served, failed };
}
