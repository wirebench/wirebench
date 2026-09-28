-- Wirebench Server 0004: catch URLs and their captures (webhook-capture spec §3.2).
-- A catch URL belongs to a workspace and goes with it. Its captures go with the catch URL. The file
-- name uses a hyphen: migrate.ts accepts [a-z0-9-] in a migration's name, not an underscore.

create table catch_urls (
  id                    text primary key,
  workspace_id          text not null references workspaces on delete cascade,
  name                  text not null,
  -- 128 random bits, Crockford base32, 26 characters: the only credential on the public route.
  secret                text not null,
  enabled               boolean not null default true,
  response_status       integer not null default 200 check (response_status between 200 and 599),
  response_content_type text,
  -- At most 64 KiB, checked by the API: JSON Schema cannot count bytes.
  response_body         text,
  response_delay_ms     integer not null default 0 check (response_delay_ms between 0 and 30000),
  created_by            text references users on delete set null,
  created_at            timestamptz not null default now()
);
create unique index catch_urls_secret on catch_urls (secret);
-- Names are unique per workspace regardless of case (§3.5, 409 hooks-name-taken).
create unique index catch_urls_workspace_name_lower on catch_urls (workspace_id, lower(name));

create table captures (
  -- A monotonic ULID: captures sort by arrival, which paging and pruning rely on.
  id           text primary key,
  catch_url_id text not null references catch_urls on delete cascade,
  received_at  timestamptz not null default now(),
  method       text not null,
  -- What followed /hooks/<secret>: '' or '/…', percent-encoded as it arrived.
  subpath      text not null,
  -- The raw query string, without '?'.
  query        text not null,
  -- [[name, value], …] in arrival order, repeats kept.
  headers      jsonb not null,
  body         bytea not null,
  -- The size that arrived, before truncation.
  body_size    integer not null,
  truncated    boolean not null,
  source_ip    text not null
);
create index captures_catch_url_id_id on captures (catch_url_id, id desc);
create index captures_received_at on captures (received_at);
