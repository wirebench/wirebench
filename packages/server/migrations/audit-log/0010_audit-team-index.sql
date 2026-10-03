-- Wirebench Server 0010: backs the team-scoped audit read (issue #208). A team admin reads one team's
-- events newest first, so the index leads with team_id and matches the (at, id) page order.
create index audit_events_team_at on audit_events (team_id, at desc, id desc) where team_id is not null;
