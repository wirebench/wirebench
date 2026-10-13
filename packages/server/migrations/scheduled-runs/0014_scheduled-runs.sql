-- Wirebench Server 0014: scheduled runs and monitors (scheduled-runs spec §4). A schedule runs a
-- workspace project on cron; its secrets and alert URLs are sealed under the schedules key and never
-- read back. Runs, their results and alert deliveries go with the schedule, and are swept by age.
create table schedules (
  id             text primary key,
  workspace_id   text not null references workspaces on delete cascade,
  name           text not null check (char_length(name) between 1 and 100),
  cron           text not null,
  time_zone      text not null,
  target         jsonb not null,
  options        jsonb not null,
  -- { targets: [...], muteAfter }: each URL and webhook secret sealed, base64.
  alerts         jsonb not null,
  -- name -> sealed value, base64.
  secrets        jsonb not null default '{}'::jsonb,
  enabled        boolean not null default true,
  next_run_at    timestamptz,
  alert_state    text not null default 'ok' check (alert_state in ('ok', 'failing')),
  failure_streak integer not null default 0,
  created_by     text references users on delete set null,
  created_at     timestamptz not null default now(),
  updated_at     timestamptz not null default now()
);

create unique index schedules_workspace_name_lower on schedules (workspace_id, lower(name));
create index schedules_due on schedules (next_run_at) where enabled;

create table schedule_runs (
  id          text primary key,
  schedule_id text not null references schedules on delete cascade,
  trigger     text not null check (trigger in ('schedule', 'manual')),
  status      text not null check (status in ('queued', 'running', 'passed', 'failed', 'errored', 'skipped', 'cancelled')),
  reason      text,
  commit_id   text,
  environment text,
  queued_at   timestamptz not null default now(),
  started_at  timestamptz,
  finished_at timestamptz,
  summary     jsonb
);

create index schedule_runs_schedule on schedule_runs (schedule_id, queued_at desc, id desc);
create index schedule_runs_open on schedule_runs (queued_at, id) where status in ('queued', 'running');
create index schedule_runs_queued_at on schedule_runs (queued_at);

-- One masked json-report request per row, in run order.
create table schedule_results (
  run_id  text not null references schedule_runs on delete cascade,
  ordinal integer not null,
  result  jsonb not null,
  primary key (run_id, ordinal)
);

-- At-least-once alert delivery: one row per target per alert.
create table schedule_alert_outbox (
  id           text primary key,
  schedule_id  text not null references schedules on delete cascade,
  run_id       text references schedule_runs on delete cascade,
  target_index integer not null,
  kind         text not null check (kind in ('failure', 'recovery')),
  payload      jsonb not null,
  state        text not null default 'pending' check (state in ('pending', 'delivered', 'dead')),
  attempts     integer not null default 0,
  next_at      timestamptz not null default now(),
  last_error   text,
  created_at   timestamptz not null default now()
);

create index schedule_alert_outbox_due on schedule_alert_outbox (next_at) where state = 'pending';
create index schedule_alert_outbox_created on schedule_alert_outbox (created_at) where state <> 'pending';
