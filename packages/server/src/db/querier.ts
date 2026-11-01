/**
 * The raw pool's shape (`db/pool.ts`), for the files that hold the pool itself: `src/db/`, `src/tenancy/` and the
 * start-up. Modules never see it (hosted edition spec §19.8 guard 2): they get `ctx.tenancy`, whose units are
 * `TenantQuerier`s, and `check:tenant-scope` refuses an import of this file elsewhere.
 */
/** The slice of `pg.Pool` the server uses, so tests can pass a fake. */
export interface Querier {
  query<R extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: readonly unknown[],
  ): Promise<{ readonly rows: R[]; readonly rowCount: number | null }>;
}

/** A querier that can also run a function inside one transaction. */
export interface Database extends Querier {
  transaction<T>(fn: (tx: Querier) => Promise<T>): Promise<T>;
  close(): Promise<void>;
}
