-- Wirebench Server 0001: the migration ledger and the workspace registry (host spec §3.4, §4.3).
create table schema_migrations (
  version    integer primary key,
  name       text not null,
  applied_at timestamptz not null default now()
);

create table workspaces (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
