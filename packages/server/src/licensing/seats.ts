// packages/server/src/licensing/seats.ts
/**
 * Seat enforcement (licensing spec §3.4). A seat is an enabled account: every user whose `disabled_at`
 * is null, server admins included. The check takes one transaction-scoped advisory lock before it
 * counts, so two acceptances racing for the last seat are serialised and the second sees the first's
 * user (plan ruling 5). A downgrade never disables anyone: this only refuses a new or restored account.
 */
import type { LicenseState } from '@wirebench/engine';
import { SERVER_SCHEMA } from '../tenancy/running-lock.js';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { seatLimit } from './errors.js';

/** A fixed first key ("WBL1") that every seat check locks on; released when the caller's transaction ends. */
export const SEAT_LOCK_KEY = 0x57424c31;

/**
 * The second key (hosted edition spec §19.8 guard 5): the schema and the tenant hashed together, so two tenants
 * never wait on each other's last seat, and neither do two test schemas. `$1` is the tenant id. The schema is
 * the running lock's (the one `server_identity` lives in), so every role and URL agrees on it; the `''` stands in
 * should neither name a schema, since a null key would take no lock at all.
 */
export const SEAT_LOCK_TENANT_KEY = `hashtext(coalesce(${SERVER_SCHEMA}, '') || ':' || $1::text)`;

/**
 * The lock before this release (Task 9 review M1): one bigint, server-wide. A self-hosted server takes it first,
 * then the tenant's, in that order every time, so a server of the last release and one of this, side by side
 * during a start-before-stop restart, still exclude each other on the last seat (the two forms are different
 * lock spaces). A hosted server takes only the tenant's: no hosted server of an older release exists, and a
 * server-wide lock would make every tenant's seat check wait on every other's. Dropped in the release after
 * (plan, Task 29).
 */
export const LEGACY_SEAT_LOCK = `select pg_advisory_xact_lock(${String(SEAT_LOCK_KEY)})`;
export const SEAT_LOCK = `select pg_advisory_xact_lock(${String(SEAT_LOCK_KEY)}, ${SEAT_LOCK_TENANT_KEY})`;

/** Seats are counted per tenant: the caller's unit sets it, and from `0021` the policy filters by it. */
export async function countEnabledUsers(db: TenantQuerier): Promise<number> {
  const rows = (await db.query<{ count: number }>('select count(*)::int as count from users where disabled_at is null'))
    .rows;
  return Number(rows[0]?.count ?? 0);
}

export async function assertSeatAvailable(
  tx: TenantQuerier,
  state: (tx: TenantQuerier) => Promise<LicenseState>,
  options: { readonly hosted?: boolean } = {},
): Promise<void> {
  if (options.hosted !== true) await tx.query(LEGACY_SEAT_LOCK);
  await tx.query(SEAT_LOCK, [tx.scope.tenantId]);
  const current = await state(tx);
  if (current.seats.limit !== null && current.seats.used >= current.seats.limit) throw seatLimit(current);
}
