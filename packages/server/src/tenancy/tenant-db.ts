/**
 * Queries inside one tenant (hosted edition spec §19.4, §19.8 guard 2). Every unit of work is a transaction
 * that first sets `wirebench.tenant_id` with `set_config(…, true)`: transaction-local, so the pooled connection
 * goes back with no tenant on it (`set local` takes no bind parameter). From `0021` on, the policy reads that
 * setting; until then the column default does the tenant's part.
 *
 * The querier handed to a unit is revoked when the unit ends. A query on it afterwards, from a call nobody
 * awaited, throws `tenancy-scope-ended` rather than running in whatever transaction that pooled client is in
 * next. A client in doubt after its unit is destroyed by the pool (`db/pool.ts`).
 *
 * **Nesting.** Repositories take the `TenantQuerier` they are given and never call `ctx.tenancy.db` themselves.
 * A `db(scope)` call made inside a running unit anyway joins it when the scope is the same one: its statements
 * run on the outer unit's connection and commit or roll back with it, rather than on a second pooled
 * connection that would commit on its own, wait on a lock the outer unit holds, and hold two clients per unit.
 * Inside a unit of another tenant it throws `tenancy-nested`.
 *
 * A statement that ends or opens a transaction (`commit`, `rollback`, `begin`…) is refused with
 * `tenancy-transaction-control`: it would end the unit early, and the setting with it.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
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

/** Statements that end or open a transaction; savepoints stay inside the unit and are allowed. */
const TRANSACTION_CONTROL = /^\s*(?:commit|rollback|begin|end|abort|start\s+transaction|prepare\s+transaction)\b/i;

interface ActiveUnit {
  readonly scope: TenantScope;
  readonly tx: TenantQuerier;
  readonly ended: () => boolean;
}

export function tenantDbFactory(db: Database, options: TenancyDbOptions = {}): TenantDbFactory {
  let units = 0;
  // The unit the current async call chain runs in. A timer a unit started may outlive it: an ended unit counts
  // as none.
  const active = new AsyncLocalStorage<ActiveUnit>();
  const outerFor = (scope: TenantScope): TenantQuerier | undefined => {
    const outer = active.getStore();
    if (outer === undefined || outer.ended()) return undefined;
    if (outer.scope.tenantId !== scope.tenantId) {
      throw new WirebenchError(
        'tenancy-nested',
        `a unit of tenant ${scope.tenantId} was started inside a unit of tenant ${outer.scope.tenantId}`,
      );
    }
    return outer.tx;
  };
  return (scope) => {
    const transaction = <T>(fn: (tx: TenantQuerier) => Promise<T>): Promise<T> => {
      let outer: TenantQuerier | undefined;
      try {
        outer = outerFor(scope);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (outer !== undefined) return fn(outer);
      return db.transaction(async (raw) => {
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
            if (TRANSACTION_CONTROL.test(text)) {
              return Promise.reject(
                new WirebenchError('tenancy-transaction-control', 'a unit of work may not end or open a transaction'),
              );
            }
            options.onStatement?.({ unit, kind: 'statement', tenantId: scope.tenantId, text });
            return raw.query(text, params);
          },
        } as TenantQuerier;
        try {
          return await active.run({ scope, tx, ended: () => ended }, () => fn(tx));
        } finally {
          ended = true;
        }
      });
    };
    return {
      scope,
      query: (text, params) => transaction((tx) => tx.query(text, params)),
      transaction,
    } as TenantDb;
  };
}
