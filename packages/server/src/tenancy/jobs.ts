/**
 * The job loop (hosted edition spec §19.8 guard 6): a background job runs once per tenant, each in its own
 * tenant unit. One tenant's failure is logged with the job's name and the tenant id, and the others still run.
 */
import type { FastifyBaseLogger } from 'fastify';
import type { TenantDirectory } from './directory.js';
import type { TenantScope } from './scope.js';
import { outsideTenantUnit, type TenantDbFactory, type TenantQuerier } from './tenant-db.js';

export interface JobLoopDeps {
  readonly directory: Pick<TenantDirectory, 'list'>;
  readonly db: TenantDbFactory;
  readonly log: Pick<FastifyBaseLogger, 'error'>;
}

/** What a job's function returns to end the pass early: the tenants after this one get no unit. */
export const STOP_PASS: unique symbol = Symbol('stop the job pass');

/**
 * What a job's function returns for work that must wait on the network: `afterUnit` runs once the tenant's unit has
 * committed, outside any unit, before the next tenant's unit opens. It opens units of its own where it needs them,
 * so no pooled connection waits on a remote end (the audit forwarder's send). A throw counts as the tenant's
 * failure, and `STOP_PASS` ends the pass as it does from the function itself.
 */
export interface AfterUnit {
  readonly afterUnit: () => Promise<void | typeof STOP_PASS>;
}

/** What a job's function may return. */
export type JobOutcome = void | typeof STOP_PASS | AfterUnit;

export interface JobPass {
  readonly served: number;
  readonly failed: readonly string[];
}

export async function forEachTenant(
  deps: JobLoopDeps,
  job: string,
  fn: (tx: TenantQuerier, scope: TenantScope) => Promise<JobOutcome>,
): Promise<JobPass> {
  const failed: string[] = [];
  let served = 0;
  for (const scope of await deps.directory.list()) {
    try {
      const committed = await deps.db(scope).transaction((tx) => fn(tx, scope));
      const outcome = typeof committed === 'object' ? await outsideTenantUnit(() => committed.afterUnit()) : committed;
      served++;
      if (outcome === STOP_PASS) break;
    } catch (error) {
      failed.push(scope.tenantId);
      deps.log.error({ err: error, job, tenantId: scope.tenantId }, 'a job failed for one tenant');
    }
  }
  return { served, failed };
}
