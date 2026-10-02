// packages/server/src/licensing/seats.ts
/**
 * Seat enforcement (licensing spec §3.4). A seat is an enabled account: every user whose `disabled_at`
 * is null, server admins included. The check takes one transaction-scoped advisory lock before it
 * counts, so two acceptances racing for the last seat are serialised and the second sees the first's
 * user (plan ruling 5). A downgrade never disables anyone: this only refuses a new or restored account.
 */
import type { LicenseState } from '@wirebench/engine';
import type { Querier } from '../context.js';
import { seatLimit } from './errors.js';

/** A fixed key ("WBL1") that every seat check locks on; released when the caller's transaction ends. */
export const SEAT_LOCK_KEY = 0x57424c31;

export async function countEnabledUsers(db: Querier): Promise<number> {
  const rows = (await db.query<{ count: number }>('select count(*)::int as count from users where disabled_at is null'))
    .rows;
  return Number(rows[0]?.count ?? 0);
}

export async function assertSeatAvailable(tx: Querier, state: (tx: Querier) => Promise<LicenseState>): Promise<void> {
  await tx.query('select pg_advisory_xact_lock($1)', [SEAT_LOCK_KEY]);
  const current = await state(tx);
  if (current.seats.limit !== null && current.seats.used >= current.seats.limit) throw seatLimit(current);
}
