/**
 * What a tenant's export holds of each scoped table (hosted edition spec §22.9). Every table the forced policy holds
 * is classified here, and a test fails on one that is not, as the route map fails on an unclassified route
 * (§19.13): a new table is never exported, or left out, by accident.
 *
 * - **`export`**: every row, every column but `tenant_id` (the import's unit sets its own).
 * - **`redact`**: every row, with the named columns replaced by the SQL given for each, so no secret, sealed or not,
 *   ever leaves the server (§3.6). Most become `null`; a `not null` column becomes its empty value, and a column a check
 *   ties to a sealed one goes with it (a catch URL's scheme with its secret), so the row still inserts.
 * - **`skip`**: no file at all: short-lived rows, a queue, the control plane's own, and what names this server.
 *
 * Password and token hashes are exported, so people sign in after an import; sessions, device tokens and pairings are
 * not, so everyone signs in again (§22.10).
 */

/** How one scoped table is exported. */
export type TableClass =
  | { readonly kind: 'export' }
  | {
      readonly kind: 'redact';
      /** Column → the SQL that replaces it, evaluated over the row. */
      readonly columns: Readonly<Record<string, string>>;
    }
  | { readonly kind: 'skip'; readonly why: string };

const exported: TableClass = { kind: 'export' };
const skip = (why: string): TableClass => ({ kind: 'skip', why });
const SHORT_LIVED = skip('short-lived: it is made again as it is needed');

/** Every scoped table, by name. */
export const EXPORT_TABLES: Readonly<Record<string, TableClass>> = {
  workspaces: exported,
  users: exported,
  local_credentials: exported,
  oidc_identities: exported,
  invitations: exported,
  teams: exported,
  team_members: exported,
  team_invitations: exported,
  workspace_grants: exported,
  ci_tokens: exported,
  catch_urls: {
    kind: 'redact',
    // The URL's own secret is its only credential: blanked, and minted again on import, so the old address stops
    // working. The signature secret is sealed; its scheme, hint and reject flag are tied to it by the table's checks.
    columns: {
      secret: "''",
      signature: 'null',
      signature_secret: 'null',
      signature_hint: 'null',
      reject_unverified: 'false',
    },
  },
  captures: exported,
  schedules: {
    kind: 'redact',
    // Every secret is sealed, and so is every alert target's URL; the targets go, the mute setting stays.
    columns: { secrets: "'{}'::jsonb", alerts: "jsonb_set(alerts, '{targets}', '[]'::jsonb)" },
  },
  schedule_runs: exported,
  schedule_results: exported,
  audit_events: exported,
  audit_chain_anchor: exported,
  saml_identities: exported,
  scim_tokens: exported,
  scim_users: exported,
  scim_groups: exported,
  scim_group_members: exported,
  provisioned_memberships: exported,
  session_logs: exported,
  session_log_chunks: exported,
  tenant_settings: { kind: 'redact', columns: { sealed: 'null' } },

  oidc_flows: SHORT_LIVED,
  browser_flows: SHORT_LIVED,
  saml_flows: SHORT_LIVED,
  device_tokens: skip('sessions: everyone signs in again after an import'),
  agent_pairing_codes: SHORT_LIVED,
  agent_nonces: SHORT_LIVED,
  agent_pairings: skip('a pairing names the server its agent dials: it is made again against the new one'),
  host_leases: SHORT_LIVED,
  limiter_buckets: SHORT_LIVED,
  send_slots: SHORT_LIVED,
  terminal_share_locations: SHORT_LIVED,
  audit_forward_queue: skip('a queue: what it held is in audit_events'),
  schedule_alert_outbox: skip('a queue of deliveries to alert targets, which are sealed and not exported'),
  license: skip("a license is bound to the exporting server's id: the target has its own"),
  subscriptions: skip("the control plane's own: a subscription stays with its tenant at the provider"),
  tenant_exports: skip("the control plane's own: the exports of the tenant"),
  custom_domains: skip('a custom name is verified again on the server it is moved to'),
};

/** The tables an export holds a file for, by name. */
export function exportedTables(): string[] {
  return Object.entries(EXPORT_TABLES)
    .filter(([, cls]) => cls.kind !== 'skip')
    .map(([table]) => table)
    .sort();
}
