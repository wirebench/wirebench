-- `wirebench-server admin tenancy revert`, its `reverting-rows` step (hosted edition spec §19.10, plan Task 28):
-- the schema back to 0019, in one transaction. The command reads this file and runs it; the migration runner
-- never does (its name has no version). It runs as the owner, after `reverting-keys` has re-sealed every blob
-- under the old per-user key and `reverting-files` has moved the directories back, so dropping `tenants` (and
-- with it the data key) loses nothing.
--
-- It undoes 0021, then 0020, and restores every 0019 key, index and foreign key under its 0019 name, with its
-- 0019 definition (`revert.test.ts` compares the catalog with the frozen fixture's). No row is rewritten:
-- dropping a column only changes the catalog, as adding it did, so sealed audit rows keep their bytes (0012's
-- rule). A dropped `tenant_id` leaves a hidden placeholder at the end of each table, so the live columns are
-- 0019's, in 0019's order.

-- The command refuses more than one tenant before it starts; checked again here, inside the unit.
do $guard$
begin
  if (select count(*) from tenants) <> 1 then
    raise exception 'tenancy-revert-tenants: the database has more than one tenant';
  end if;
end
$guard$;

-- 0021: the policies, the setting defaults (back to the default tenant's constant, as 0020 left them, before
-- the column goes), the two functions and the forwarder's lease.
do $policies$
declare
  tenant uuid := (select default_tenant_id from server_identity);
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
    execute format('drop policy if exists tenant_isolation on %I', t);
    execute format('alter table %I no force row level security', t);
    execute format('alter table %I disable row level security', t);
    execute format('alter table %I alter column tenant_id set default %L', t, tenant);
  end loop;
end
$policies$;
drop function for_each_tenant(text);
drop function tenant_scope(regclass);
alter table audit_forward_queue drop column lease_id, drop column leased_until;

-- 0020's host-instance lease (§19.9): 0019 has no such table. Its policy goes with it.
drop table host_leases;

-- Every composite foreign key, to come back single-column under the same name once the keys it names are 0019's.
alter table agent_nonces drop constraint agent_nonces_pairing_id_fkey, drop constraint agent_nonces_user_id_fkey;
alter table agent_pairing_codes drop constraint agent_pairing_codes_user_id_fkey;
alter table agent_pairings drop constraint agent_pairings_user_id_fkey;
alter table audit_forward_queue drop constraint audit_forward_queue_event_id_fkey;
alter table captures drop constraint captures_catch_url_id_fkey;
alter table catch_urls drop constraint catch_urls_created_by_fkey, drop constraint catch_urls_workspace_id_fkey;
alter table ci_tokens drop constraint ci_tokens_created_by_fkey, drop constraint ci_tokens_workspace_id_fkey;
alter table device_tokens drop constraint device_tokens_user_id_fkey;
alter table invitations drop constraint invitations_created_by_fkey, drop constraint invitations_user_id_fkey;
alter table license drop constraint license_installed_by_fkey;
alter table local_credentials drop constraint local_credentials_user_id_fkey;
alter table oidc_identities drop constraint oidc_identities_user_id_fkey;
alter table provisioned_memberships
  drop constraint provisioned_memberships_group_id_fkey,
  drop constraint provisioned_memberships_team_id_user_id_fkey;
alter table saml_identities drop constraint saml_identities_user_id_fkey;
alter table schedule_alert_outbox
  drop constraint schedule_alert_outbox_run_id_fkey,
  drop constraint schedule_alert_outbox_schedule_id_fkey;
alter table schedule_results drop constraint schedule_results_run_id_fkey;
alter table schedule_runs drop constraint schedule_runs_schedule_id_fkey;
alter table schedules drop constraint schedules_created_by_fkey, drop constraint schedules_workspace_id_fkey;
alter table scim_group_members
  drop constraint scim_group_members_group_id_fkey,
  drop constraint scim_group_members_user_id_fkey;
alter table scim_groups drop constraint scim_groups_team_id_fkey;
alter table scim_tokens drop constraint scim_tokens_created_by_fkey;
alter table scim_users drop constraint scim_users_user_id_fkey;
alter table session_log_chunks drop constraint session_log_chunks_log_id_fkey;
alter table session_logs drop constraint session_logs_user_id_fkey, drop constraint session_logs_workspace_id_fkey;
alter table team_invitations
  drop constraint team_invitations_invitation_id_fkey,
  drop constraint team_invitations_team_id_fkey;
alter table team_members drop constraint team_members_team_id_fkey, drop constraint team_members_user_id_fkey;
alter table workspace_grants
  drop constraint workspace_grants_user_id_fkey,
  drop constraint workspace_grants_workspace_id_fkey;
alter table workspaces drop constraint workspaces_created_by_fkey, drop constraint workspaces_team_id_fkey;

-- Rule 3's keys on (tenant_id, id), the targets of the composite foreign keys: 0019 has none.
alter table users drop constraint users_tenant_id_id_key;
alter table invitations drop constraint invitations_tenant_id_id_key;
alter table teams drop constraint teams_tenant_id_id_key;
alter table catch_urls drop constraint catch_urls_tenant_id_id_key;
alter table schedules drop constraint schedules_tenant_id_id_key;
alter table schedule_runs drop constraint schedule_runs_tenant_id_id_key;
alter table audit_events drop constraint audit_events_tenant_id_id_key;
alter table scim_groups drop constraint scim_groups_tenant_id_id_key;
alter table session_logs drop constraint session_logs_tenant_id_id_key;
alter table agent_pairings drop constraint agent_pairings_tenant_id_id_key;

-- Rule 2's primary keys, back to 0019's columns: the singleton keys on the kept `singleton` and `only_row` too.
alter table workspaces drop constraint workspaces_pkey, add constraint workspaces_pkey primary key (id);
alter table local_credentials
  drop constraint local_credentials_pkey, add constraint local_credentials_pkey primary key (user_id);
alter table oidc_identities
  drop constraint oidc_identities_pkey, add constraint oidc_identities_pkey primary key (issuer, subject);
alter table team_members
  drop constraint team_members_pkey, add constraint team_members_pkey primary key (team_id, user_id);
alter table team_invitations
  drop constraint team_invitations_pkey, add constraint team_invitations_pkey primary key (invitation_id);
alter table workspace_grants
  drop constraint workspace_grants_pkey, add constraint workspace_grants_pkey primary key (workspace_id, user_id);
alter table license drop constraint license_pkey, add constraint license_pkey primary key (singleton);
alter table schedule_results
  drop constraint schedule_results_pkey, add constraint schedule_results_pkey primary key (run_id, ordinal);
alter table audit_forward_queue
  drop constraint audit_forward_queue_pkey, add constraint audit_forward_queue_pkey primary key (event_id);
alter table audit_chain_anchor
  drop constraint audit_chain_anchor_pkey, add constraint audit_chain_anchor_pkey primary key (only_row);
alter table saml_identities
  drop constraint saml_identities_pkey, add constraint saml_identities_pkey primary key (entity_id, name_id);
alter table scim_users drop constraint scim_users_pkey, add constraint scim_users_pkey primary key (user_id);
alter table scim_group_members
  drop constraint scim_group_members_pkey, add constraint scim_group_members_pkey primary key (group_id, user_id);
alter table provisioned_memberships
  drop constraint provisioned_memberships_pkey,
  add constraint provisioned_memberships_pkey primary key (team_id, user_id, group_id);
alter table session_log_chunks
  drop constraint session_log_chunks_pkey, add constraint session_log_chunks_pkey primary key (log_id, offset_bytes);
alter table agent_pairing_codes
  drop constraint agent_pairing_codes_pkey, add constraint agent_pairing_codes_pkey primary key (code_hash);
alter table agent_nonces drop constraint agent_nonces_pkey, add constraint agent_nonces_pkey primary key (nonce_hash);

-- Rule 2's unique constraints.
alter table users drop constraint users_email_lower_key, add constraint users_email_lower_key unique (email_lower);
alter table invitations
  drop constraint invitations_secret_hash_key, add constraint invitations_secret_hash_key unique (secret_hash);
alter table device_tokens
  drop constraint device_tokens_token_hash_key, add constraint device_tokens_token_hash_key unique (token_hash);
alter table oidc_flows
  drop constraint oidc_flows_state_key, add constraint oidc_flows_state_key unique (state),
  drop constraint oidc_flows_grant_hash_key, add constraint oidc_flows_grant_hash_key unique (grant_hash);
alter table browser_flows
  drop constraint browser_flows_state_hash_key, add constraint browser_flows_state_hash_key unique (state_hash);
alter table ci_tokens
  drop constraint ci_tokens_token_hash_key, add constraint ci_tokens_token_hash_key unique (token_hash);
alter table saml_flows
  drop constraint saml_flows_request_id_key, add constraint saml_flows_request_id_key unique (request_id),
  drop constraint saml_flows_relay_state_key, add constraint saml_flows_relay_state_key unique (relay_state),
  drop constraint saml_flows_grant_hash_key, add constraint saml_flows_grant_hash_key unique (grant_hash);
alter table scim_tokens
  drop constraint scim_tokens_token_hash_key, add constraint scim_tokens_token_hash_key unique (token_hash);
alter table session_logs
  drop constraint session_logs_workspace_id_user_id_client_log_id_key,
  add constraint session_logs_workspace_id_user_id_client_log_id_key unique (workspace_id, user_id, client_log_id);
alter table agent_pairings
  drop constraint agent_pairings_user_id_agent_id_key,
  add constraint agent_pairings_user_id_agent_id_key unique (user_id, agent_id);
alter table agent_pairing_codes
  drop constraint agent_pairing_codes_user_id_key, add constraint agent_pairing_codes_user_id_key unique (user_id);

-- Rule 2's unique indexes.
drop index invitations_one_open_per_email;
create unique index invitations_one_open_per_email
  on invitations (email_lower) where kind = 'invite' and accepted_at is null and revoked_at is null;
drop index teams_name_lower;
create unique index teams_name_lower on teams (lower(name));
drop index workspaces_team_name_lower;
create unique index workspaces_team_name_lower on workspaces (team_id, lower(name));
drop index ci_tokens_workspace_name_lower;
create unique index ci_tokens_workspace_name_lower on ci_tokens (workspace_id, lower(name)) where revoked_at is null;
drop index catch_urls_secret;
create unique index catch_urls_secret on catch_urls (secret);
drop index catch_urls_workspace_name_lower;
create unique index catch_urls_workspace_name_lower on catch_urls (workspace_id, lower(name));
drop index schedules_workspace_name_lower;
create unique index schedules_workspace_name_lower on schedules (workspace_id, lower(name));
drop index audit_events_chain_seq;
create unique index audit_events_chain_seq on audit_events (chain_seq) where chain_seq is not null;
drop index scim_tokens_name_lower;
create unique index scim_tokens_name_lower on scim_tokens (lower(name)) where revoked_at is null;
drop index scim_groups_display_name_lower;
create unique index scim_groups_display_name_lower on scim_groups (lower(display_name));

-- Rule 4's listing indexes, back to 0019's columns.
drop index audit_events_at;
create index audit_events_at on audit_events (at desc, id desc);
drop index audit_events_action_at;
create index audit_events_action_at on audit_events (action, at desc);
drop index audit_events_unsealed;
create index audit_events_unsealed on audit_events (at, id) where chain_seq is null;
drop index captures_received_at;
create index captures_received_at on captures (received_at);
drop index schedules_due;
create index schedules_due on schedules (next_run_at) where enabled;
drop index schedule_runs_open;
create index schedule_runs_open on schedule_runs (queued_at, id) where status in ('queued', 'running');
drop index schedule_runs_queued_at;
create index schedule_runs_queued_at on schedule_runs (queued_at);
drop index schedule_alert_outbox_due;
create index schedule_alert_outbox_due on schedule_alert_outbox (next_at) where state = 'pending';
drop index schedule_alert_outbox_created;
create index schedule_alert_outbox_created on schedule_alert_outbox (created_at) where state <> 'pending';
drop index session_logs_last_write;
create index session_logs_last_write on session_logs (last_write_at);
drop index agent_nonces_expires_at;
create index agent_nonces_expires_at on agent_nonces (expires_at);

-- The foreign keys of 0019, single-column, under their names.
alter table agent_nonces
  add constraint agent_nonces_pairing_id_fkey foreign key (pairing_id) references agent_pairings (id) on delete cascade,
  add constraint agent_nonces_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table agent_pairing_codes
  add constraint agent_pairing_codes_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table agent_pairings
  add constraint agent_pairings_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table audit_forward_queue
  add constraint audit_forward_queue_event_id_fkey foreign key (event_id) references audit_events (id) on delete cascade;
alter table captures
  add constraint captures_catch_url_id_fkey foreign key (catch_url_id) references catch_urls (id) on delete cascade;
alter table catch_urls
  add constraint catch_urls_created_by_fkey foreign key (created_by) references users (id) on delete set null,
  add constraint catch_urls_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete cascade;
alter table ci_tokens
  add constraint ci_tokens_created_by_fkey foreign key (created_by) references users (id) on delete set null,
  add constraint ci_tokens_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete cascade;
alter table device_tokens
  add constraint device_tokens_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table invitations
  add constraint invitations_created_by_fkey foreign key (created_by) references users (id) on delete set null,
  add constraint invitations_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table license
  add constraint license_installed_by_fkey foreign key (installed_by) references users (id) on delete set null;
alter table local_credentials
  add constraint local_credentials_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table oidc_identities
  add constraint oidc_identities_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table provisioned_memberships
  add constraint provisioned_memberships_group_id_fkey foreign key (group_id) references scim_groups (id) on delete cascade,
  add constraint provisioned_memberships_team_id_user_id_fkey foreign key (team_id, user_id)
    references team_members (team_id, user_id) on delete cascade;
alter table saml_identities
  add constraint saml_identities_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table schedule_alert_outbox
  add constraint schedule_alert_outbox_run_id_fkey foreign key (run_id) references schedule_runs (id) on delete cascade,
  add constraint schedule_alert_outbox_schedule_id_fkey foreign key (schedule_id) references schedules (id) on delete cascade;
alter table schedule_results
  add constraint schedule_results_run_id_fkey foreign key (run_id) references schedule_runs (id) on delete cascade;
alter table schedule_runs
  add constraint schedule_runs_schedule_id_fkey foreign key (schedule_id) references schedules (id) on delete cascade;
alter table schedules
  add constraint schedules_created_by_fkey foreign key (created_by) references users (id) on delete set null,
  add constraint schedules_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete cascade;
alter table scim_group_members
  add constraint scim_group_members_group_id_fkey foreign key (group_id) references scim_groups (id) on delete cascade,
  add constraint scim_group_members_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table scim_groups
  add constraint scim_groups_team_id_fkey foreign key (team_id) references teams (id) on delete set null;
alter table scim_tokens
  add constraint scim_tokens_created_by_fkey foreign key (created_by) references users (id) on delete set null;
alter table scim_users
  add constraint scim_users_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table session_log_chunks
  add constraint session_log_chunks_log_id_fkey foreign key (log_id) references session_logs (id) on delete cascade;
alter table session_logs
  add constraint session_logs_user_id_fkey foreign key (user_id) references users (id) on delete cascade,
  add constraint session_logs_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete cascade;
alter table team_invitations
  add constraint team_invitations_invitation_id_fkey foreign key (invitation_id) references invitations (id) on delete cascade,
  add constraint team_invitations_team_id_fkey foreign key (team_id) references teams (id) on delete cascade;
alter table team_members
  add constraint team_members_team_id_fkey foreign key (team_id) references teams (id) on delete cascade,
  add constraint team_members_user_id_fkey foreign key (user_id) references users (id) on delete cascade;
alter table workspace_grants
  add constraint workspace_grants_user_id_fkey foreign key (user_id) references users (id) on delete cascade,
  add constraint workspace_grants_workspace_id_fkey foreign key (workspace_id) references workspaces (id) on delete cascade;
alter table workspaces
  add constraint workspaces_created_by_fkey foreign key (created_by) references users (id) on delete set null,
  add constraint workspaces_team_id_fkey foreign key (team_id) references teams (id) on delete restrict;

-- The column itself, table by table: catalog-only, and its key to `tenants` goes with it.
do $columns$
declare
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
    execute format('alter table %I drop column tenant_id', t);
  end loop;
end
$columns$;

-- `tenants`, with the default tenant's data key, then the two server_identity columns last. Until this unit
-- commits, `tenancy_step` still says `reverting-rows`, so a kill anywhere above resumes here.
alter table server_identity drop constraint server_identity_default_tenant_id_fkey;
drop table tenants;
alter table server_identity drop column default_tenant_id, drop column tenancy_step;
delete from schema_migrations where version in (20, 21);
