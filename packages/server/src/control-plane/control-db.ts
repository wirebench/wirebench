/**
 * The control plane's connection (hosted edition spec §22.2, ADR-0039): a pool on the control role, the one role
 * past row-level security. `ControlDb` is branded, so nothing builds one but {@link openControlDb}, which only
 * `serve.ts` calls, in hosted mode, and hands to the control plane alone. No route runs on it, and no per-tenant
 * write: those run in the tenant's unit on the app role. `check:tenant-scope` keeps its name, and this module, to
 * `src/control-plane/` and `serve.ts`.
 */
import type { ControlHandle } from '../context.js';
import { APPLICATION_NAME, createDatabase } from '../db/pool.js';
import type { Database } from '../db/querier.js';

declare const controlDbBrand: unique symbol;

/** A pool on the control role. The brand is type-only: a `Database` is not a `ControlDb` without a cast. */
export type ControlDb = Database & { readonly [controlDbBrand]: true };

/** At most two connections: the control plane's work is a webhook, a sweep and an operator command at a time. */
export const CONTROL_POOL_MAX = 2;

/** What its connections are called in `pg_stat_activity`: a server's, so a revert waits for them too. */
export const CONTROL_APPLICATION_NAME = `${APPLICATION_NAME}-control`;

/** Opens the control pool on `url`. Connects lazily, as every pool does; `checkControlRole` is its first query. */
export function openControlDb(url: string, options: { readonly onError?: (error: Error) => void } = {}): ControlDb {
  return createDatabase(url, {
    max: CONTROL_POOL_MAX,
    applicationName: CONTROL_APPLICATION_NAME,
    ...(options.onError !== undefined ? { onError: options.onError } : {}),
  }) as ControlDb;
}

/** The pool as `ctx.control` carries it: `serve.ts` puts it there. */
export function controlHandle(db: ControlDb): ControlHandle {
  return db as unknown as ControlHandle;
}

/** The pool behind `ctx.control`: only the control plane takes it back. */
export function controlDbOf(handle: ControlHandle): ControlDb {
  return handle as unknown as ControlDb;
}
