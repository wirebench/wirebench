-- Wirebench Server 0016: team session logs (#430). A workspace admin's switch makes every SSH session on
-- the workspace's hosts stream its masked text log here while it runs. A log is metadata plus its bytes
-- in order; nothing edits a log, only retention and an admin delete remove one.
alter table workspaces add column record_session_logs boolean not null default false;

create table session_logs (
  id            text primary key,
  workspace_id  text not null references workspaces on delete cascade,
  user_id       text not null references users on delete cascade,
  client_log_id text not null,
  host_id       text not null,
  host_name     text not null,
  address       text not null,
  port          integer not null,
  ssh_user      text not null,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  exit_code     integer,
  signal        text,
  reason        text,
  size_bytes    bigint not null default 0,
  truncated     boolean not null default false,
  last_write_at timestamptz not null,
  unique (workspace_id, user_id, client_log_id)
);
create index session_logs_workspace_id on session_logs (workspace_id, id desc);
create index session_logs_last_write on session_logs (last_write_at);

create table session_log_chunks (
  log_id       text not null references session_logs on delete cascade,
  offset_bytes bigint not null,
  data         bytea not null,
  primary key (log_id, offset_bytes)
);
