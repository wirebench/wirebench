-- Wirebench Server 0014: SAML sign-in and SCIM provisioning (saml-scim spec §4), the `sso` module. It names
-- `users`, `teams`, `team_members` and `audit_events`, whose migrations all run earlier in the global
-- order. The audit log learns the `scim` actor here too (plan ruling 10).
create table saml_identities (
  entity_id text not null,
  name_id   text not null,
  user_id   text not null references users on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (entity_id, name_id)
);
create index saml_identities_user_id on saml_identities (user_id);

-- One pending SAML sign-in. request_id is the AuthnRequest's ID, which the response's InResponseTo must
-- name; relay_state finds the flow when the IdP posts back. Granted at most once (grant_hash is null).
create table saml_flows (
  id             text primary key,
  request_id     text not null unique,
  code_challenge text not null,
  loopback_port  integer not null,
  device_name    text not null,
  relay_state    text not null unique,
  grant_hash     text unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  user_id        text
);

-- Only the SHA-256 of a token is kept. A revoked token's name is free again.
create table scim_tokens (
  id           text primary key,
  name         text not null check (char_length(name) between 1 and 64),
  token_hash   text not null unique,
  created_by   text references users on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);
create unique index scim_tokens_name_lower on scim_tokens (lower(name)) where revoked_at is null;

create table scim_users (
  user_id     text primary key references users on delete cascade,
  external_id text,
  created_at  timestamptz not null default now(),
  updated_at  timestamptz not null default now()
);

create table scim_groups (
  id           text primary key,
  display_name text not null,
  external_id  text,
  team_id      text references teams on delete set null,
  created_at   timestamptz not null default now(),
  updated_at   timestamptz not null default now()
);
create unique index scim_groups_display_name_lower on scim_groups (lower(display_name));
create index scim_groups_team_id on scim_groups (team_id);

create table scim_group_members (
  group_id text not null references scim_groups on delete cascade,
  user_id  text not null references users on delete cascade,
  primary key (group_id, user_id)
);
create index scim_group_members_user_id on scim_group_members (user_id);

-- A team membership SCIM added because of a linked group (spec §3.6). It goes with the membership.
create table provisioned_memberships (
  team_id  text not null,
  user_id  text not null,
  group_id text not null references scim_groups on delete cascade,
  primary key (team_id, user_id, group_id),
  foreign key (team_id, user_id) references team_members (team_id, user_id) on delete cascade
);
create index provisioned_memberships_group_id on provisioned_memberships (group_id);

alter table audit_events drop constraint audit_events_actor_kind_check;
alter table audit_events
  add constraint audit_events_actor_kind_check
  check (actor_kind in ('user', 'ci-token', 'system', 'anonymous', 'scim'));
