/**
 * The tenant a unit of work runs in (hosted edition spec §19.5, §19.8 guard 2). A `TenantScope` is branded,
 * so a module cannot make one from a string: the tenant directory, the request resolver (Task 6) and the job
 * loop build them, through `scopeOf` below, which only `src/tenancy/` calls.
 */
declare const scopeBrand: unique symbol;

export interface TenantScope {
  readonly tenantId: string;
  readonly slug: string;
  readonly [scopeBrand]: true;
}

/** For `src/tenancy/` only: the one way to brand a tenant row as a scope. */
export function scopeOf(row: { readonly id: string; readonly slug: string }): TenantScope {
  return Object.freeze({ tenantId: row.id, slug: row.slug }) as TenantScope;
}

/**
 * A tenant id as Postgres prints a `uuid` and `randomUUID()` makes one, and nothing else: no upper case, braces or
 * missing dashes. The one pattern both the paths and the key derivation check (Task 23 re-review m4): `::uuid`
 * accepts the other spellings, which would name another directory or derive another key.
 */
export const CANONICAL_UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
