-- Wirebench Server 0008: the audit log (audit-log spec §4.2). Append-only by the absence of routes:
-- nothing updates or deletes a row except retention. No foreign keys: an event outlives the user,
-- workspace or hook it names. (at, id) is the order and the page cursor; id is a ULID minted at insert.
create table audit_events (
  id                 text primary key,
  at                 timestamptz not null default now(),
  actor_kind         text not null check (actor_kind in ('user', 'ci-token', 'system', 'anonymous')),
  actor_user_id      text,
  actor_email        text,
  actor_token_id     text,
  actor_workspace_id text,
  action             text not null,
  target_kind        text not null,
  target_id          text,
  workspace_id       text,
  team_id            text,
  ip                 inet,
  user_agent         text,
  details            jsonb not null default '{}'::jsonb
);
create index audit_events_at on audit_events (at desc, id desc);
create index audit_events_workspace_at on audit_events (workspace_id, at desc) where workspace_id is not null;
create index audit_events_actor_at on audit_events (actor_user_id, at desc) where actor_user_id is not null;
create index audit_events_action_at on audit_events (action, at desc);
