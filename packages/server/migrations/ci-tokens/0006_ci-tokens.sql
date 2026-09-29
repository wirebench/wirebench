-- Wirebench Server 0006: CI tokens (callback-assertion spec §3). A CI token reads captures in one
-- workspace and nothing else. Only its SHA-256 hash is kept. It never expires and is never swept:
-- revoking sets revoked_at, which the guard checks on every request. A revoked token's name is free
-- again, so the unique name index covers live tokens only.
create table ci_tokens (
  id           text primary key,
  workspace_id text not null references workspaces on delete cascade,
  name         text not null check (char_length(name) between 1 and 64),
  token_hash   text not null unique,
  created_by   text references users on delete set null,
  created_at   timestamptz not null default now(),
  last_used_at timestamptz,
  revoked_at   timestamptz
);

create unique index ci_tokens_workspace_name_lower on ci_tokens (workspace_id, lower(name)) where revoked_at is null;
create index ci_tokens_workspace_id on ci_tokens (workspace_id);
