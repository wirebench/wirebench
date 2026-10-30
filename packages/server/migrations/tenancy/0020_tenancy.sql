-- Wirebench Server 0020: the tenants and the column (hosted edition spec §19.2, §19.3, §19.10). Every table but
-- schema_migrations and server_identity gains tenant_id, with the default tenant's id as a constant default:
-- adding a column with a constant default only changes the catalog, so no row is rewritten and no sealed audit
-- row changes (0012's rule). No policy yet: 0021 switches the default to the setting and forces row-level
-- security. Every key, index and foreign key rebuilt here keeps its 0019 name (§19.3, rule 6): routes map
-- violations by name, and the revert restores them by name.
--
-- Until 0021 no query names a tenant, so an index led by tenant_id serves no lookup by token, email or id.
-- Every 0019 index this file rebuilds therefore stays, as `<name>_0019`, and 0021 drops the copies once its
-- policy makes tenant_id an equality in every query:
-- - a non-unique index, and a unique one whose name no route maps, is renamed, which costs nothing (with one
--   tenant its uniqueness still holds);
-- - a primary key, and a unique key a route maps by name, gets a non-unique copy built first: a primary key
--   cannot be kept beside the new one, and a second unique index on the old columns would be checked first
--   (lower OID) and report a violation under the `_0019` name, turning a 409 into a 500;
-- - so does the unique key of an `on conflict` upsert: two racing inserts that both pass the arbiter's check
--   would otherwise meet the older unique copy, which raises instead of taking the conflict path.
set local maintenance_work_mem = '256MB';

create table tenants (
  id          uuid primary key,
  slug        text not null check (slug ~ '^[a-z0-9]([a-z0-9-]{1,38}[a-z0-9])?$'),
  name        text not null,
  edition     text not null default 'community' check (edition in ('community', 'team', 'enterprise')),
  status      text not null default 'active' check (status in ('active', 'suspended', 'deleting')),
  region      text not null default 'eu' check (region in ('eu')),
  seats       integer check (seats > 0),
  data_key    bytea,
  created_at  timestamptz not null default now(),
  deleting_at timestamptz
);
create unique index tenants_slug on tenants (slug);

-- The default tenant exists on every installation, fresh or upgraded. tenancy_step drives the file step that
-- start-up runs after the migrations (§19.10).
insert into tenants (id, slug, name) values (gen_random_uuid(), 'default', 'Default');
alter table server_identity
  add column default_tenant_id uuid references tenants (id),
  add column tenancy_step text check (
    tenancy_step in ('files', 'keys', 'done', 'reverting-keys', 'reverting-files', 'reverting-rows')
  );
update server_identity set default_tenant_id = (select id from tenants where slug = 'default'), tenancy_step = 'files';

-- The host-instance lease (§19.9). Created here with the rest, used from slice 4's Part E.
create table host_leases (
  tenant_id   uuid not null references tenants (id),
  user_id     text not null,
  holder      text not null,
  acquired_at timestamptz not null,
  renewed_at  timestamptz not null,
  expires_at  timestamptz not null
);

-- Rule 1: the column, named table by table. A table someone forgot is caught by the migration test, not
-- scoped by accident.
do $tenancy$
declare
  tenant uuid := (select id from tenants where slug = 'default');
  t text;
begin
  for t in select unnest(array[
    'workspaces',
    'users', 'local_credentials', 'oidc_identities', 'invitations', 'device_tokens', 'oidc_flows', 'browser_flows',
    'teams', 'team_members', 'team_invitations', 'workspace_grants',
    'license',
    'ci_tokens',
    'catch_urls', 'captures',
    'schedules', 'schedule_runs', 'schedule_results', 'schedule_alert_outbox',
    'audit_events', 'audit_forward_queue', 'audit_chain_anchor',
    'saml_identities', 'saml_flows', 'scim_tokens', 'scim_users', 'scim_groups', 'scim_group_members',
    'provisioned_memberships',
    'session_logs', 'session_log_chunks',
    'agent_pairings', 'agent_pairing_codes', 'agent_nonces'
  ])
  loop
    execute format('alter table %I add column tenant_id uuid not null default %L references tenants (id)', t, tenant);
  end loop;
  execute format('alter table host_leases alter column tenant_id set default %L', tenant);
end
$tenancy$;

-- Every foreign key between scoped tables goes, to come back composite under its own name once the keys it
-- names exist.
alter table workspaces drop constraint workspaces_team_id_fkey, drop constraint workspaces_created_by_fkey;
alter table local_credentials drop constraint local_credentials_user_id_fkey;
alter table oidc_identities drop constraint oidc_identities_user_id_fkey;
alter table invitations drop constraint invitations_user_id_fkey, drop constraint invitations_created_by_fkey;
alter table device_tokens drop constraint device_tokens_user_id_fkey;
alter table team_members drop constraint team_members_team_id_fkey, drop constraint team_members_user_id_fkey;
alter table team_invitations
  drop constraint team_invitations_invitation_id_fkey,
  drop constraint team_invitations_team_id_fkey;
alter table workspace_grants
  drop constraint workspace_grants_workspace_id_fkey,
  drop constraint workspace_grants_user_id_fkey;
alter table license drop constraint license_installed_by_fkey;
alter table ci_tokens drop constraint ci_tokens_workspace_id_fkey, drop constraint ci_tokens_created_by_fkey;
alter table catch_urls drop constraint catch_urls_workspace_id_fkey, drop constraint catch_urls_created_by_fkey;
alter table captures drop constraint captures_catch_url_id_fkey;
alter table schedules drop constraint schedules_workspace_id_fkey, drop constraint schedules_created_by_fkey;
alter table schedule_runs drop constraint schedule_runs_schedule_id_fkey;
alter table schedule_results drop constraint schedule_results_run_id_fkey;
alter table schedule_alert_outbox
  drop constraint schedule_alert_outbox_schedule_id_fkey,
  drop constraint schedule_alert_outbox_run_id_fkey;
alter table audit_forward_queue drop constraint audit_forward_queue_event_id_fkey;
alter table saml_identities drop constraint saml_identities_user_id_fkey;
alter table scim_tokens drop constraint scim_tokens_created_by_fkey;
alter table scim_users drop constraint scim_users_user_id_fkey;
alter table scim_groups drop constraint scim_groups_team_id_fkey;
alter table scim_group_members
  drop constraint scim_group_members_group_id_fkey,
  drop constraint scim_group_members_user_id_fkey;
alter table provisioned_memberships
  drop constraint provisioned_memberships_group_id_fkey,
  drop constraint provisioned_memberships_team_id_user_id_fkey;
alter table session_logs drop constraint session_logs_workspace_id_fkey, drop constraint session_logs_user_id_fkey;
alter table session_log_chunks drop constraint session_log_chunks_log_id_fkey;
alter table agent_pairings drop constraint agent_pairings_user_id_fkey;
alter table agent_pairing_codes drop constraint agent_pairing_codes_user_id_fkey;
alter table agent_nonces drop constraint agent_nonces_pairing_id_fkey, drop constraint agent_nonces_user_id_fkey;

-- Rule 2: primary keys that are not a lone minted id lead with tenant_id. workspaces.id comes from the desktop,
-- so one workspace may be shared into two tenants. Rule 5: one license and one chain anchor per tenant; their
-- singleton and only_row columns stay, with their check and default, for the revert.
create index workspaces_pkey_0019 on workspaces (id);
alter table workspaces drop constraint workspaces_pkey;
alter table workspaces add constraint workspaces_pkey primary key (tenant_id, id);
create index local_credentials_pkey_0019 on local_credentials (user_id);
alter table local_credentials drop constraint local_credentials_pkey;
alter table local_credentials add constraint local_credentials_pkey primary key (tenant_id, user_id);
create index oidc_identities_pkey_0019 on oidc_identities (issuer, subject);
alter table oidc_identities drop constraint oidc_identities_pkey;
alter table oidc_identities add constraint oidc_identities_pkey primary key (tenant_id, issuer, subject);
create index team_members_pkey_0019 on team_members (team_id, user_id);
alter table team_members drop constraint team_members_pkey;
alter table team_members add constraint team_members_pkey primary key (tenant_id, team_id, user_id);
create index team_invitations_pkey_0019 on team_invitations (invitation_id);
alter table team_invitations drop constraint team_invitations_pkey;
alter table team_invitations add constraint team_invitations_pkey primary key (tenant_id, invitation_id);
create index workspace_grants_pkey_0019 on workspace_grants (workspace_id, user_id);
alter table workspace_grants drop constraint workspace_grants_pkey;
alter table workspace_grants add constraint workspace_grants_pkey primary key (tenant_id, workspace_id, user_id);
create index license_pkey_0019 on license (singleton);
alter table license drop constraint license_pkey;
alter table license add constraint license_pkey primary key (tenant_id);
create index schedule_results_pkey_0019 on schedule_results (run_id, ordinal);
alter table schedule_results drop constraint schedule_results_pkey;
alter table schedule_results add constraint schedule_results_pkey primary key (tenant_id, run_id, ordinal);
create index audit_forward_queue_pkey_0019 on audit_forward_queue (event_id);
alter table audit_forward_queue drop constraint audit_forward_queue_pkey;
alter table audit_forward_queue add constraint audit_forward_queue_pkey primary key (tenant_id, event_id);
create index audit_chain_anchor_pkey_0019 on audit_chain_anchor (only_row);
alter table audit_chain_anchor drop constraint audit_chain_anchor_pkey;
alter table audit_chain_anchor add constraint audit_chain_anchor_pkey primary key (tenant_id);
create index saml_identities_pkey_0019 on saml_identities (entity_id, name_id);
alter table saml_identities drop constraint saml_identities_pkey;
alter table saml_identities add constraint saml_identities_pkey primary key (tenant_id, entity_id, name_id);
create index scim_users_pkey_0019 on scim_users (user_id);
alter table scim_users drop constraint scim_users_pkey;
alter table scim_users add constraint scim_users_pkey primary key (tenant_id, user_id);
create index scim_group_members_pkey_0019 on scim_group_members (group_id, user_id);
alter table scim_group_members drop constraint scim_group_members_pkey;
alter table scim_group_members add constraint scim_group_members_pkey primary key (tenant_id, group_id, user_id);
create index provisioned_memberships_pkey_0019 on provisioned_memberships (team_id, user_id, group_id);
alter table provisioned_memberships drop constraint provisioned_memberships_pkey;
alter table provisioned_memberships
  add constraint provisioned_memberships_pkey primary key (tenant_id, team_id, user_id, group_id);
create index session_log_chunks_pkey_0019 on session_log_chunks (log_id, offset_bytes);
alter table session_log_chunks drop constraint session_log_chunks_pkey;
alter table session_log_chunks add constraint session_log_chunks_pkey primary key (tenant_id, log_id, offset_bytes);
create index agent_pairing_codes_pkey_0019 on agent_pairing_codes (code_hash);
alter table agent_pairing_codes drop constraint agent_pairing_codes_pkey;
alter table agent_pairing_codes add constraint agent_pairing_codes_pkey primary key (tenant_id, code_hash);
create index agent_nonces_pkey_0019 on agent_nonces (nonce_hash);
alter table agent_nonces drop constraint agent_nonces_pkey;
alter table agent_nonces add constraint agent_nonces_pkey primary key (tenant_id, nonce_hash);
alter table host_leases add constraint host_leases_pkey primary key (tenant_id, user_id);

-- Rule 2: every unique constraint and unique index leads with tenant_id. The old ones stay as `_0019` (above).
-- Mapped by name (scim users), so its copy is not unique.
create index users_email_lower_key_0019 on users (email_lower);
alter table users drop constraint users_email_lower_key;
alter table users add constraint users_email_lower_key unique (tenant_id, email_lower);
alter table invitations rename constraint invitations_secret_hash_key to invitations_secret_hash_key_0019;
alter table invitations add constraint invitations_secret_hash_key unique (tenant_id, secret_hash);
alter table device_tokens rename constraint device_tokens_token_hash_key to device_tokens_token_hash_key_0019;
alter table device_tokens add constraint device_tokens_token_hash_key unique (tenant_id, token_hash);
alter table oidc_flows rename constraint oidc_flows_state_key to oidc_flows_state_key_0019;
alter table oidc_flows rename constraint oidc_flows_grant_hash_key to oidc_flows_grant_hash_key_0019;
alter table oidc_flows
  add constraint oidc_flows_state_key unique (tenant_id, state),
  add constraint oidc_flows_grant_hash_key unique (tenant_id, grant_hash);
alter table browser_flows rename constraint browser_flows_state_hash_key to browser_flows_state_hash_key_0019;
alter table browser_flows add constraint browser_flows_state_hash_key unique (tenant_id, state_hash);
alter table ci_tokens rename constraint ci_tokens_token_hash_key to ci_tokens_token_hash_key_0019;
alter table ci_tokens add constraint ci_tokens_token_hash_key unique (tenant_id, token_hash);
alter table saml_flows rename constraint saml_flows_request_id_key to saml_flows_request_id_key_0019;
alter table saml_flows rename constraint saml_flows_relay_state_key to saml_flows_relay_state_key_0019;
alter table saml_flows rename constraint saml_flows_grant_hash_key to saml_flows_grant_hash_key_0019;
alter table saml_flows
  add constraint saml_flows_request_id_key unique (tenant_id, request_id),
  add constraint saml_flows_relay_state_key unique (tenant_id, relay_state),
  add constraint saml_flows_grant_hash_key unique (tenant_id, grant_hash);
alter table scim_tokens rename constraint scim_tokens_token_hash_key to scim_tokens_token_hash_key_0019;
alter table scim_tokens add constraint scim_tokens_token_hash_key unique (tenant_id, token_hash);
-- The arbiters of `openLog`, `upsertPairing` and `replaceCode`: non-unique copies, so a racing upsert takes its
-- conflict path (header).
create index session_logs_workspace_id_user_id_client_log_id_key_0019
  on session_logs (workspace_id, user_id, client_log_id);
alter table session_logs drop constraint session_logs_workspace_id_user_id_client_log_id_key;
alter table session_logs
  add constraint session_logs_workspace_id_user_id_client_log_id_key unique (tenant_id, workspace_id, user_id, client_log_id);
create index agent_pairings_user_id_agent_id_key_0019 on agent_pairings (user_id, agent_id);
alter table agent_pairings drop constraint agent_pairings_user_id_agent_id_key;
alter table agent_pairings add constraint agent_pairings_user_id_agent_id_key unique (tenant_id, user_id, agent_id);
create index agent_pairing_codes_user_id_key_0019 on agent_pairing_codes (user_id);
alter table agent_pairing_codes drop constraint agent_pairing_codes_user_id_key;
alter table agent_pairing_codes add constraint agent_pairing_codes_user_id_key unique (tenant_id, user_id);

create index invitations_one_open_per_email_0019
  on invitations (email_lower) where kind = 'invite' and accepted_at is null and revoked_at is null;
drop index invitations_one_open_per_email;
create unique index invitations_one_open_per_email
  on invitations (tenant_id, email_lower) where kind = 'invite' and accepted_at is null and revoked_at is null;
create index teams_name_lower_0019 on teams (lower(name));
drop index teams_name_lower;
create unique index teams_name_lower on teams (tenant_id, lower(name));
create index workspaces_team_name_lower_0019 on workspaces (team_id, lower(name));
drop index workspaces_team_name_lower;
create unique index workspaces_team_name_lower on workspaces (tenant_id, team_id, lower(name));
create index ci_tokens_workspace_name_lower_0019 on ci_tokens (workspace_id, lower(name)) where revoked_at is null;
drop index ci_tokens_workspace_name_lower;
create unique index ci_tokens_workspace_name_lower
  on ci_tokens (tenant_id, workspace_id, lower(name)) where revoked_at is null;
alter index catch_urls_secret rename to catch_urls_secret_0019;
create unique index catch_urls_secret on catch_urls (tenant_id, secret);
create index catch_urls_workspace_name_lower_0019 on catch_urls (workspace_id, lower(name));
drop index catch_urls_workspace_name_lower;
create unique index catch_urls_workspace_name_lower on catch_urls (tenant_id, workspace_id, lower(name));
create index schedules_workspace_name_lower_0019 on schedules (workspace_id, lower(name));
drop index schedules_workspace_name_lower;
create unique index schedules_workspace_name_lower on schedules (tenant_id, workspace_id, lower(name));
-- One chain per tenant.
alter index audit_events_chain_seq rename to audit_events_chain_seq_0019;
create unique index audit_events_chain_seq on audit_events (tenant_id, chain_seq) where chain_seq is not null;
create index scim_tokens_name_lower_0019 on scim_tokens (lower(name)) where revoked_at is null;
drop index scim_tokens_name_lower;
create unique index scim_tokens_name_lower on scim_tokens (tenant_id, lower(name)) where revoked_at is null;
create index scim_groups_display_name_lower_0019 on scim_groups (lower(display_name));
drop index scim_groups_display_name_lower;
create unique index scim_groups_display_name_lower on scim_groups (tenant_id, lower(display_name));

-- Rule 3: every table another names gets a key on (tenant_id, id), the target of the composite keys below.
alter table users add constraint users_tenant_id_id_key unique (tenant_id, id);
alter table invitations add constraint invitations_tenant_id_id_key unique (tenant_id, id);
alter table teams add constraint teams_tenant_id_id_key unique (tenant_id, id);
alter table catch_urls add constraint catch_urls_tenant_id_id_key unique (tenant_id, id);
alter table schedules add constraint schedules_tenant_id_id_key unique (tenant_id, id);
alter table schedule_runs add constraint schedule_runs_tenant_id_id_key unique (tenant_id, id);
alter table audit_events add constraint audit_events_tenant_id_id_key unique (tenant_id, id);
alter table scim_groups add constraint scim_groups_tenant_id_id_key unique (tenant_id, id);
alter table session_logs add constraint session_logs_tenant_id_id_key unique (tenant_id, id);
alter table agent_pairings add constraint agent_pairings_tenant_id_id_key unique (tenant_id, id);

-- Rule 3: the foreign keys again, composite, so a row can never name another tenant's row. `set null (x)`
-- nulls the reference and never the tenant column.
alter table workspaces
  add constraint workspaces_team_id_fkey foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete restrict,
  add constraint workspaces_created_by_fkey foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by);
alter table local_credentials
  add constraint local_credentials_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table oidc_identities
  add constraint oidc_identities_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table invitations
  add constraint invitations_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade,
  add constraint invitations_created_by_fkey foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by);
alter table device_tokens
  add constraint device_tokens_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table team_members
  add constraint team_members_team_id_fkey foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade,
  add constraint team_members_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table team_invitations
  add constraint team_invitations_invitation_id_fkey foreign key (tenant_id, invitation_id) references invitations (tenant_id, id) on delete cascade,
  add constraint team_invitations_team_id_fkey foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete cascade;
alter table workspace_grants
  add constraint workspace_grants_workspace_id_fkey foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id) on delete cascade,
  add constraint workspace_grants_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table license
  add constraint license_installed_by_fkey foreign key (tenant_id, installed_by) references users (tenant_id, id) on delete set null (installed_by);
alter table ci_tokens
  add constraint ci_tokens_workspace_id_fkey foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id) on delete cascade,
  add constraint ci_tokens_created_by_fkey foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by);
alter table catch_urls
  add constraint catch_urls_workspace_id_fkey foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id) on delete cascade,
  add constraint catch_urls_created_by_fkey foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by);
alter table captures
  add constraint captures_catch_url_id_fkey foreign key (tenant_id, catch_url_id) references catch_urls (tenant_id, id) on delete cascade;
alter table schedules
  add constraint schedules_workspace_id_fkey foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id) on delete cascade,
  add constraint schedules_created_by_fkey foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by);
alter table schedule_runs
  add constraint schedule_runs_schedule_id_fkey foreign key (tenant_id, schedule_id) references schedules (tenant_id, id) on delete cascade;
alter table schedule_results
  add constraint schedule_results_run_id_fkey foreign key (tenant_id, run_id) references schedule_runs (tenant_id, id) on delete cascade;
alter table schedule_alert_outbox
  add constraint schedule_alert_outbox_schedule_id_fkey foreign key (tenant_id, schedule_id) references schedules (tenant_id, id) on delete cascade,
  add constraint schedule_alert_outbox_run_id_fkey foreign key (tenant_id, run_id) references schedule_runs (tenant_id, id) on delete cascade;
alter table audit_forward_queue
  add constraint audit_forward_queue_event_id_fkey foreign key (tenant_id, event_id) references audit_events (tenant_id, id) on delete cascade;
alter table saml_identities
  add constraint saml_identities_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table scim_tokens
  add constraint scim_tokens_created_by_fkey foreign key (tenant_id, created_by) references users (tenant_id, id) on delete set null (created_by);
alter table scim_users
  add constraint scim_users_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table scim_groups
  add constraint scim_groups_team_id_fkey foreign key (tenant_id, team_id) references teams (tenant_id, id) on delete set null (team_id);
alter table scim_group_members
  add constraint scim_group_members_group_id_fkey foreign key (tenant_id, group_id) references scim_groups (tenant_id, id) on delete cascade,
  add constraint scim_group_members_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table provisioned_memberships
  add constraint provisioned_memberships_group_id_fkey foreign key (tenant_id, group_id) references scim_groups (tenant_id, id) on delete cascade,
  add constraint provisioned_memberships_team_id_user_id_fkey foreign key (tenant_id, team_id, user_id) references team_members (tenant_id, team_id, user_id) on delete cascade;
alter table session_logs
  add constraint session_logs_workspace_id_fkey foreign key (tenant_id, workspace_id) references workspaces (tenant_id, id) on delete cascade,
  add constraint session_logs_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table session_log_chunks
  add constraint session_log_chunks_log_id_fkey foreign key (tenant_id, log_id) references session_logs (tenant_id, id) on delete cascade;
alter table agent_pairings
  add constraint agent_pairings_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table agent_pairing_codes
  add constraint agent_pairing_codes_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table agent_nonces
  add constraint agent_nonces_pairing_id_fkey foreign key (tenant_id, pairing_id) references agent_pairings (tenant_id, id) on delete cascade,
  add constraint agent_nonces_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;
alter table host_leases
  add constraint host_leases_user_id_fkey foreign key (tenant_id, user_id) references users (tenant_id, id) on delete cascade;

-- Rule 4: a listing index led by a parent id stays; every other non-unique index leads with tenant_id, since
-- every list and sweep now runs inside one tenant.
alter index audit_events_at rename to audit_events_at_0019;
create index audit_events_at on audit_events (tenant_id, at desc, id desc);
alter index audit_events_action_at rename to audit_events_action_at_0019;
create index audit_events_action_at on audit_events (tenant_id, action, at desc);
alter index audit_events_unsealed rename to audit_events_unsealed_0019;
create index audit_events_unsealed on audit_events (tenant_id, at, id) where chain_seq is null;
alter index captures_received_at rename to captures_received_at_0019;
create index captures_received_at on captures (tenant_id, received_at);
alter index schedules_due rename to schedules_due_0019;
create index schedules_due on schedules (tenant_id, next_run_at) where enabled;
alter index schedule_runs_open rename to schedule_runs_open_0019;
create index schedule_runs_open on schedule_runs (tenant_id, queued_at, id) where status in ('queued', 'running');
alter index schedule_runs_queued_at rename to schedule_runs_queued_at_0019;
create index schedule_runs_queued_at on schedule_runs (tenant_id, queued_at);
alter index schedule_alert_outbox_due rename to schedule_alert_outbox_due_0019;
create index schedule_alert_outbox_due on schedule_alert_outbox (tenant_id, next_at) where state = 'pending';
alter index schedule_alert_outbox_created rename to schedule_alert_outbox_created_0019;
create index schedule_alert_outbox_created on schedule_alert_outbox (tenant_id, created_at) where state <> 'pending';
alter index session_logs_last_write rename to session_logs_last_write_0019;
create index session_logs_last_write on session_logs (tenant_id, last_write_at);
alter index agent_nonces_expires_at rename to agent_nonces_expires_at_0019;
create index agent_nonces_expires_at on agent_nonces (tenant_id, expires_at);

-- The policy every scoped table gets in 0021 (§19.4). Created now, called by nothing yet.
create function tenant_scope(t regclass) returns void language plpgsql as $scope$
begin
  execute format('alter table %s enable row level security', t);
  execute format('alter table %s force row level security', t);
  execute format(
    'create policy tenant_isolation on %s for all to public '
    'using (tenant_id = nullif(current_setting(''wirebench.tenant_id'', true), '''')::uuid) '
    'with check (tenant_id = nullif(current_setting(''wirebench.tenant_id'', true), '''')::uuid)',
    t
  );
end
$scope$;

-- The new leading columns have no statistics until autovacuum reaches them; the planner would choose badly
-- until then.
analyze workspaces, users, local_credentials, oidc_identities, invitations, device_tokens, oidc_flows,
  browser_flows, teams, team_members, team_invitations, workspace_grants, license, ci_tokens, catch_urls,
  captures, schedules, schedule_runs, schedule_results, schedule_alert_outbox, audit_events, audit_forward_queue,
  audit_chain_anchor, saml_identities, saml_flows, scim_tokens, scim_users, scim_groups, scim_group_members,
  provisioned_memberships, session_logs, session_log_chunks, agent_pairings, agent_pairing_codes, agent_nonces,
  host_leases, tenants;
