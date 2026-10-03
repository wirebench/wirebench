-- Wirebench Server 0011: the outbox for forwarding audit events to syslog or HTTPS (issue #209). The
-- audit hook inserts an event's id here in the same transaction as the event, only when forwarding is
-- configured, so only committed events are queued. The forwarder deletes a row once the sink accepts
-- the event; retention deletes events, and the cascade takes their rows with them.
create table audit_forward_queue (
  event_id text primary key references audit_events(id) on delete cascade,
  queued_at timestamptz not null default now()
);
