/**
 * Queries inside one tenant (hosted edition spec §19.4, §19.8 guard 2). Every unit of work is a transaction
 * that first sets `wirebench.tenant_id` with `set_config(…, true)`: transaction-local, so the pooled connection
 * goes back with no tenant on it (`set local` takes no bind parameter). From `0021` on, the policy reads that
 * setting; until then the column default does the tenant's part.
 *
 * The querier handed to a unit is revoked when the unit ends. A query on it afterwards, from a call nobody
 * awaited, throws `tenancy-scope-ended` rather than running in whatever transaction that pooled client is in
 * next. A client in doubt after its unit is destroyed by the pool (`db/pool.ts`).
 */
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../context.js';
import type { TenantScope } from './scope.js';

declare const querierBrand: unique symbol;

/** A querier bound to one tenant: what repositories take in place of `Querier` (Parts B and C). */
export interface TenantQuerier extends Querier {
  readonly scope: TenantScope;
  readonly [querierBrand]: true;
}

/** One tenant's database. `query` is one statement in its own unit; `transaction` runs a unit of work. */
export interface TenantDb extends TenantQuerier {
  transaction<T>(fn: (tx: TenantQuerier) => Promise<T>): Promise<T>;
}

/** What a test reads: each statement, the unit it ran in, and the tenant that unit had set before it. */
export interface StatementLogEntry {
  /** Counts units across the process, from 1. */
  readonly unit: number;
  readonly kind: 'set-config' | 'statement';
  readonly tenantId: string;
  readonly text: string;
}

export interface TenancyDbOptions {
  /** Test only: called for every `set_config` and every statement, in the order they are sent. */
  readonly onStatement?: (entry: StatementLogEntry) => void;
}

/** `ctx.tenancy.db(scope)`. */
export type TenantDbFactory = (scope: TenantScope) => TenantDb;

export const SET_TENANT = "select set_config('wirebench.tenant_id', $1, true)";

export function tenantDbFactory(db: Database, options: TenancyDbOptions = {}): TenantDbFactory {
  let units = 0;
  return (scope) => {
    const transaction = <T>(fn: (tx: TenantQuerier) => Promise<T>): Promise<T> =>
      db.transaction(async (raw) => {
        const unit = ++units;
        await raw.query(SET_TENANT, [scope.tenantId]);
        options.onStatement?.({ unit, kind: 'set-config', tenantId: scope.tenantId, text: SET_TENANT });
        let ended = false;
        const tx = {
          scope,
          query: (text: string, params?: readonly unknown[]) => {
            if (ended) {
              return Promise.reject(
                new WirebenchError(
                  'tenancy-scope-ended',
                  'a query ran on a tenant querier after its unit of work ended',
                ),
              );
            }
            options.onStatement?.({ unit, kind: 'statement', tenantId: scope.tenantId, text });
            return raw.query(text, params);
          },
        } as TenantQuerier;
        try {
          return await fn(tx);
        } finally {
          ended = true;
        }
      });
    return {
      scope,
      query: (text, params) => transaction((tx) => tx.query(text, params)),
      transaction,
    } as TenantDb;
  };
}
