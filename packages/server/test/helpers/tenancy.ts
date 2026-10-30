/**
 * Test helpers for modules moved into a tenant (plan, Global Constraints; spec §19.13). Until `0021` forces the
 * policy, a moved module is tested on one tenant, and its suite shows that every statement it runs goes
 * through the tenant database:
 * - it registers with `scopedContext(ctx)`, whose `db` throws `tenancy-unscoped`;
 * - `statementLog()` records each statement with the tenant its unit set first, and `expectAllScoped` checks it.
 */
import { WirebenchError } from '@wirebench/engine';
import { expect } from 'vitest';
import type { Database, ServerContext } from '../../src/context.js';
import type { StatementLogEntry } from '../../src/tenancy/tenant-db.js';
import { createTenancy, type Tenancy } from '../../src/tenancy/tenancy.js';

/**
 * A `Proxy` over the one shared context: reading `db` throws, and every other read and write passes through,
 * so licensing's replacement of `ctx.license` and `buildServer`'s `log` reach the shared context.
 */
export function scopedContext(ctx: ServerContext): ServerContext {
  return new Proxy(ctx, {
    get(target, property, receiver) {
      if (property === 'db') {
        throw new WirebenchError('tenancy-unscoped', 'this module reached ctx.db; it must go through ctx.tenancy');
      }
      return Reflect.get(target, property, receiver) as unknown;
    },
    set(target, property, value) {
      return Reflect.set(target, property, value);
    },
  });
}

/** `buildServer`'s `contextFor`: `scopedContext` for the named modules, the shared context for the rest. */
export function scopedFor(...names: readonly string[]) {
  return (module: { readonly name: string }, context: ServerContext): ServerContext =>
    names.includes(module.name) ? scopedContext(context) : context;
}

export interface StatementLog {
  readonly entries: StatementLogEntry[];
  readonly onStatement: (entry: StatementLogEntry) => void;
}

export function statementLog(): StatementLog {
  const entries: StatementLogEntry[] = [];
  return { entries, onStatement: (entry) => entries.push(entry) };
}

/** A tenancy over `db` that records every statement. */
export function loggedTenancy(db: Database): { readonly tenancy: Tenancy; readonly log: StatementLog } {
  const log = statementLog();
  return { tenancy: createTenancy(db, { onStatement: log.onStatement }), log };
}

/**
 * Every statement ran in a unit whose `set_config` came first and named `tenantId`. At least one statement must
 * be in the log, so a fill that wrote nothing does not pass.
 */
export function expectAllScoped(log: StatementLog, tenantId: string): void {
  const set = new Map<number, string>();
  let statements = 0;
  for (const entry of log.entries) {
    if (entry.kind === 'set-config') set.set(entry.unit, entry.tenantId);
    else {
      statements++;
      // Read as the statement is reached, so a set_config logged after it does not count.
      expect(set.get(entry.unit), entry.text).toBe(tenantId);
    }
  }
  expect(statements, 'statements in the log').toBeGreaterThan(0);
}
