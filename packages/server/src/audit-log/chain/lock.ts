/**
 * The audit chain's transaction-scoped advisory lock (audit-chain spec §3.2 step 1, §3.3). Sealer passes
 * and retention batches take it, so a pass (which reads the head and the anchor) and a batch (which
 * moves the anchor) never interleave, across server instances too. Inserts never take it.
 *
 * Advisory locks are database-wide, so the lock is keyed by the schema and the tenant together (hosted edition
 * spec §19.8 guard 5): the two-int form takes {@link AUDIT_CHAIN_LOCK_CLASS} and
 * `hashtext(current_schema() || ':' || tenant_id)`. One chain per tenant, so two tenants' passes never wait on
 * each other, and servers (or test files) on different schemas of one database never share it.
 */
import type { TenantQuerier } from '../../tenancy/tenant-db.js';

/** The lock's first key, an int4 (the ASCII of "wbac"); the second hashes the schema and the tenant. */
export const AUDIT_CHAIN_LOCK_CLASS = 0x77626163;

/** Takes the unit's tenant's chain lock if it is free, without waiting; true when taken. */
export async function tryLockChain(tx: TenantQuerier): Promise<boolean> {
  const result = await tx.query<{ locked: boolean }>(
    "select pg_try_advisory_xact_lock($1::int, hashtext(current_schema() || ':' || $2::text)) as locked",
    [AUDIT_CHAIN_LOCK_CLASS, tx.scope.tenantId],
  );
  return result.rows[0]?.locked === true;
}
