/**
 * Queries inside one tenant (hosted edition spec §19.4, §19.8 guard 2). Every unit of work is a transaction
 * that first sets `wirebench.tenant_id` with `set_config(…, true)`: transaction-local, so the pooled connection
 * goes back with no tenant on it (`set local` takes no bind parameter). The forced policy of `0021` reads that
 * setting, and every `tenant_id` defaults to it, so outside a unit a scoped table reads as empty and refuses writes.
 *
 * The querier handed to a unit is revoked when the unit ends. A query on it afterwards, from a call nobody
 * awaited, throws `tenancy-scope-ended` rather than running in whatever transaction that pooled client is in
 * next. A client in doubt after its unit is destroyed by the pool (`db/pool.ts`).
 *
 * **Nesting.** Repositories take the `TenantQuerier` they are given and never call `ctx.tenancy.db` themselves.
 * A `db(scope)` call made inside a running unit anyway joins it when the scope is the same one: its statements
 * run on the outer unit's connection and commit or roll back with it, rather than on a second pooled
 * connection that would commit on its own, wait on a lock the outer unit holds, and hold two clients per unit.
 * A joined `transaction` runs inside a savepoint, so its failure undoes only its own statements and leaves the
 * outer unit usable; a joined `query` runs as it is. Inside a unit of another tenant it throws `tenancy-nested`.
 *
 * **Every statement of a unit is awaited inside it.** Work a unit starts and does not await is not supported: a
 * unit whose function settles while one of its statements, or a joined unit, is still running fails with
 * `tenancy-unawaited` and rolls back, rather than committing what happened to finish. A statement sent after
 * the unit ended throws `tenancy-scope-ended`, as above.
 *
 * A statement that ends or opens a transaction (`commit`, `rollback`, `begin`…), after any leading comments, is
 * refused with `tenancy-transaction-control`: it would end the unit early, and the setting with it. So is text
 * holding more than one statement (`tenancy-multi-statement`), which `pg` would run whole when sent without
 * parameters.
 */
import { AsyncLocalStorage } from 'node:async_hooks';
import { WirebenchError } from '@wirebench/engine';
import type { Database, Querier } from '../db/querier.js';
import type { TenantScope } from './scope.js';

declare const querierBrand: unique symbol;

/** A querier bound to one tenant: what repositories take in place of `Querier` (Parts B and C). */
export interface TenantQuerier extends Querier {
  readonly scope: TenantScope;
  readonly [querierBrand]: true;
}

/** One tenant's database. `query` is one statement in its own unit; `transaction` runs a unit of work. */
export interface TenantDb extends TenantQuerier {
  transaction<T>(fn: (tx: TenantQuerier) => Promise<T>, options?: UnitOptions): Promise<T>;
}

export interface UnitOptions {
  /**
   * A `repeatable read, read only` unit: every statement reads one snapshot (the audit chain's verify walk). It is
   * set before the tenant, as Postgres requires, so such a unit cannot join one already running.
   */
  readonly readOnlySnapshot?: boolean;
}

/** Sent before the tenant's `set_config` in a {@link UnitOptions.readOnlySnapshot} unit. */
export const READ_ONLY_SNAPSHOT = 'set transaction isolation level repeatable read, read only';

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
const TRANSACTION_CONTROL =
  /^\s*(?:commit|rollback(?!\s+(?:work\s+|transaction\s+)?to\b)|begin|end|abort|start\s+transaction|prepare\s+transaction)\b/i;

/**
 * `text` with its comments, string literals, quoted identifiers and dollar-quoted bodies blanked out, so what is
 * left is the statement's own words and punctuation.
 */
export function sqlSkeleton(text: string): string {
  // An `E'…'` string reads `\'` as a quote inside it, so it is matched before a plain one.
  return text.replace(
    /--[^\n]*|\/\*[\s\S]*?\*\/|(?<![\w$])[eE]'(?:[^'\\]|\\[\s\S]|'')*'|'(?:[^']|'')*'|"(?:[^"]|"")*"|\$([A-Za-z_]*)\$[\s\S]*?\$\1\$/g,
    ' ',
  );
}

/** Why `text` may not run inside a unit, or `undefined`. */
export function refusedStatement(text: string): WirebenchError | undefined {
  const skeleton = sqlSkeleton(text);
  if (TRANSACTION_CONTROL.test(skeleton)) {
    return new WirebenchError('tenancy-transaction-control', 'a unit of work may not end or open a transaction');
  }
  if (/;\s*\S/.test(skeleton)) {
    return new WirebenchError('tenancy-multi-statement', 'a unit of work sends one statement at a time');
  }
  return undefined;
}

interface ActiveUnit {
  readonly scope: TenantScope;
  readonly tx: TenantQuerier;
  readonly ended: () => boolean;
  /** Runs `work` as part of the unit, so the unit knows it is still out. */
  readonly track: <T>(work: () => Promise<T>) => Promise<T>;
}

// The units the current async call chain runs in, one per factory. A timer a unit started may outlive it: an
// ended unit counts as none. One store for every factory, so `outsideTenantUnit` can leave all of them, keyed
// by factory, so a unit of one factory opened inside another's never hides the outer one (Task 8 review M2).
const active = new AsyncLocalStorage<ReadonlyMap<object, ActiveUnit>>();

/**
 * Runs `fn` outside any tenant unit (Task 6 re-review R4). For work that starts in a unit but is not part of
 * it: an announcement's listeners, which nobody awaits. A listener that reached `ctx.tenancy.db` from inside
 * the unit would join it, and the unit would then fail with `tenancy-unawaited` and roll back.
 */
export function outsideTenantUnit<T>(fn: () => T): T {
  return active.exit(fn);
}

export function tenantDbFactory(db: Database, options: TenancyDbOptions = {}): TenantDbFactory {
  let units = 0;
  const factory = {};
  let savepoints = 0;
  const outerFor = (scope: TenantScope): ActiveUnit | undefined => {
    const outer = active.getStore()?.get(factory);
    if (outer === undefined || outer.ended()) return undefined;
    if (outer.scope.tenantId !== scope.tenantId) {
      throw new WirebenchError(
        'tenancy-nested',
        `a unit of tenant ${scope.tenantId} was started inside a unit of tenant ${outer.scope.tenantId}`,
      );
    }
    return outer;
  };
  /** A joined `transaction`: the outer unit's connection, inside a savepoint of its own. */
  const joined = <T>(outer: ActiveUnit, fn: (tx: TenantQuerier) => Promise<T>): Promise<T> =>
    outer.track(async () => {
      const name = `tenancy_${String(++savepoints)}`;
      await outer.tx.query(`savepoint ${name}`);
      try {
        const result = await fn(outer.tx);
        await outer.tx.query(`release savepoint ${name}`);
        return result;
      } catch (error) {
        try {
          await outer.tx.query(`rollback to savepoint ${name}`);
        } catch (rollback) {
          // The inner failure is the one the caller needs; the rollback's rides along as its cause, and the
          // outer unit, now in doubt, fails on its next statement.
          if (error instanceof Error && error.cause === undefined) {
            Object.defineProperty(error, 'cause', { value: rollback, configurable: true, writable: true });
          }
        }
        throw error;
      }
    });
  return (scope) => {
    const transaction = <T>(fn: (tx: TenantQuerier) => Promise<T>, unitOptions: UnitOptions = {}): Promise<T> => {
      let outer: ActiveUnit | undefined;
      try {
        outer = outerFor(scope);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      if (outer !== undefined) {
        if (unitOptions.readOnlySnapshot === true) {
          return Promise.reject(
            new WirebenchError('tenancy-snapshot-joined', 'a read-only snapshot unit cannot join a running unit'),
          );
        }
        return joined(outer, fn);
      }
      return db.transaction(async (raw) => {
        const unit = ++units;
        if (unitOptions.readOnlySnapshot === true) await raw.query(READ_ONLY_SNAPSHOT);
        await raw.query(SET_TENANT, [scope.tenantId]);
        options.onStatement?.({ unit, kind: 'set-config', tenantId: scope.tenantId, text: SET_TENANT });
        let ended = false;
        let inFlight = 0;
        const track = async <R>(work: () => Promise<R>): Promise<R> => {
          inFlight++;
          try {
            return await work();
          } finally {
            inFlight--;
          }
        };
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
            const refused = refusedStatement(text);
            if (refused !== undefined) return Promise.reject(refused);
            options.onStatement?.({ unit, kind: 'statement', tenantId: scope.tenantId, text });
            return track(() => raw.query(text, params));
          },
        } as TenantQuerier;
        try {
          const running = new Map(active.getStore()).set(factory, { scope, tx, ended: () => ended, track });
          const result = await active.run(running, () => fn(tx));
          if (inFlight > 0) {
            throw new WirebenchError(
              'tenancy-unawaited',
              'a unit of work ended while a statement it started was still running; await every statement inside it',
            );
          }
          return result;
        } finally {
          ended = true;
        }
      });
    };
    const query = (text: string, params?: readonly unknown[]) => {
      let outer: ActiveUnit | undefined;
      try {
        outer = outerFor(scope);
      } catch (error) {
        return Promise.reject(error instanceof Error ? error : new Error(String(error)));
      }
      // A joined statement runs as it is, on the outer unit.
      if (outer !== undefined) return outer.tx.query(text, params);
      return transaction((tx) => tx.query(text, params));
    };
    return { scope, query, transaction } as TenantDb;
  };
}
