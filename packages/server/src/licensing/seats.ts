// packages/server/src/licensing/seats.ts
/**
 * Seat enforcement (licensing spec §3.4). A seat is an enabled account: every user whose `disabled_at`
 * is null, server admins included. The check takes one transaction-scoped advisory lock before it
 * counts, so two acceptances racing for the last seat are serialised and the second sees the first's
 * user (plan ruling 5). A downgrade never disables anyone: this only refuses a new or restored account.
 */
import type { LicenseState } from '@wirebench/engine';
import type { TenantQuerier } from '../tenancy/tenant-db.js';
import { seatLimit } from './errors.js';

/** A fixed first key ("WBL1") that every seat check locks on; released when the caller's transaction ends. */
export const SEAT_LOCK_KEY = 0x57424c31;

/**
 * The second key (hosted edition spec §19.8 guard 5): the schema and the tenant hashed together, so two tenants
 * never wait on each other's last seat, and neither do two test schemas. `$1` is the tenant id. The schema is
 * coalesced: on a schema the role may not use, `current_schema()` is null, and a null key would take no lock.
 */
export const SEAT_LOCK_TENANT_KEY = "hashtext(coalesce(current_schema(), '') || ':' || $1::text)";

/** Seats are counted per tenant: the caller's unit sets it, and from `0021` the policy filters by it. */
export async function countEnabledUsers(db: TenantQuerier): Promise<number> {
  const rows = (await db.query<{ count: number }>('select count(*)::int as count from users where disabled_at is null'))
    .rows;
  return Number(rows[0]?.count ?? 0);
}

export async function assertSeatAvailable(
  tx: TenantQuerier,
  state: (tx: TenantQuerier) => Promise<LicenseState>,
): Promise<void> {
  await tx.query(`select pg_advisory_xact_lock(${String(SEAT_LOCK_KEY)}, ${SEAT_LOCK_TENANT_KEY})`, [
    tx.scope.tenantId,
  ]);
  const current = await state(tx);
  if (current.seats.limit !== null && current.seats.used >= current.seats.limit) throw seatLimit(current);
}
