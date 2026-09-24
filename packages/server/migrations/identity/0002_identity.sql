-- Wirebench Server 0002: identity (identity spec §4.2). `email` keeps what the admin typed for
-- display; `email_lower` is the key every comparison uses.
create table users (
  id           text primary key,
  email        text not null,
  email_lower  text not null unique,
  display_name text not null,
  server_admin boolean not null default false,
  created_at   timestamptz not null default now(),
  disabled_at  timestamptz
);

create table local_credentials (
  user_id       text primary key references users on delete cascade,
  password_hash text not null,
  updated_at    timestamptz not null default now()
);

create table oidc_identities (
  issuer    text not null,
  subject   text not null,
  user_id   text not null references users on delete cascade,
  linked_at timestamptz not null default now(),
  primary key (issuer, subject)
);
create index oidc_identities_user_id on oidc_identities (user_id);

create table invitations (
  id           text primary key,
  kind         text not null check (kind in ('invite', 'reset')),
  email        text not null,
  email_lower  text not null,
  user_id      text references users on delete cascade,
  secret_hash  text not null unique,
  server_admin boolean not null default false,
  created_by   text references users on delete set null,
  created_at   timestamptz not null default now(),
  expires_at   timestamptz not null,
  accepted_at  timestamptz,
  revoked_at   timestamptz
);
-- One open invitation per email (§4.2); resets are per user and may coexist with an invite.
create unique index invitations_one_open_per_email
  on invitations (email_lower) where kind = 'invite' and accepted_at is null and revoked_at is null;

create table device_tokens (
  id           text primary key,
  user_id      text not null references users on delete cascade,
  token_hash   text not null unique,
  device_name  text not null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz not null default now(),
  revoked_at   timestamptz
);
create index device_tokens_user_id on device_tokens (user_id);

create table oidc_flows (
  id             text primary key,
  code_challenge text not null,
  loopback_port  integer not null,
  device_name    text not null,
  state          text not null unique,
  nonce          text not null,
  grant_hash     text unique,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null,
  user_id        text
);
