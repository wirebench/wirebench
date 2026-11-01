/**
 * How long migration `0020` takes on an installation (hosted edition spec §19.10), for `admin tenancy check`:
 *
 * `T ≈ Σ over tables of passes × (rows ÷ R + pg_relation_size ÷ B)`, where `passes = 1 + rebuilt indexes +
 * composite foreign keys`.
 *
 * A `0019` database cannot say what `0020` will build, so the passes are this table's, which a test reads back
 * from the catalog after `0020` and compares.
 */

/** One rate: rows a second through one pass, and heap bytes a second through one sequential scan. */
export interface MigrationRate {
  readonly rowsPerSecond: number;
  readonly heapBytesPerSecond: number;
}

/**
 * Plan Task 4's measurement (`test/perf/baselines/tenancy-migration.json`, which a test keeps this equal to), on a
 * warm machine with the heap in the page cache: the low end of the estimate.
 */
export const MEASURED_RATE: MigrationRate = { rowsPerSecond: 2_824_459, heapBytesPerSecond: 6_921_450_698 };

/** The spec's conservative figures: 0.5 million rows a second, and 200 MB a second from a cold SSD. */
export const CONSERVATIVE_RATE: MigrationRate = { rowsPerSecond: 500_000, heapBytesPerSecond: 200_000_000 };

/**
 * The passes `0020` makes over each `0019` table: one, plus each index it builds and each composite key it
 * validates. `host_leases`, which `0020` creates, has no rows to pass over.
 */
export const MIGRATION_PASSES: Readonly<Record<string, number>> = {
  agent_nonces: 6,
  agent_pairing_codes: 6,
  agent_pairings: 5,
  audit_chain_anchor: 3,
  audit_events: 6,
  audit_forward_queue: 4,
  browser_flows: 2,
  captures: 3,
  catch_urls: 7,
  ci_tokens: 6,
  device_tokens: 3,
  invitations: 7,
  license: 4,
  local_credentials: 4,
  oidc_flows: 3,
  oidc_identities: 4,
  provisioned_memberships: 5,
  saml_flows: 4,
  saml_identities: 4,
  schedule_alert_outbox: 5,
  schedule_results: 4,
  schedule_runs: 5,
  schedules: 7,
  scim_group_members: 5,
  scim_groups: 5,
  scim_tokens: 5,
  scim_users: 4,
  session_log_chunks: 4,
  session_logs: 7,
  team_invitations: 5,
  team_members: 5,
  teams: 4,
  users: 4,
  workspace_grants: 5,
  workspaces: 7,
};

export interface TableSize {
  readonly table: string;
  readonly rows: number;
  readonly heapBytes: number;
}

/** The passes of `table`, or one for a table `0020` does not rebuild. */
export function passesOf(table: string): number {
  return MIGRATION_PASSES[table] ?? 1;
}

/** Seconds `0020` takes over `tables` at `rate`. */
export function estimateSeconds(tables: readonly TableSize[], rate: MigrationRate): number {
  return tables.reduce(
    (sum, t) => sum + passesOf(t.table) * (t.rows / rate.rowsPerSecond + t.heapBytes / rate.heapBytesPerSecond),
    0,
  );
}
