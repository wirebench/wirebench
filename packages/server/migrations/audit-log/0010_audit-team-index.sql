-- Wirebench Server 0010: backs the team-scoped audit read (issue #208). A team admin reads one team's
-- events newest first, so the index leads with team_id and matches the (at, id) page order.
-- Events recorded before this release named a workspace but no team; they take the workspace's team
-- (workspaces never change team), filled before the index so it is built once.
update audit_events e set team_id = w.team_id from workspaces w where e.team_id is null and e.workspace_id = w.id;
create index audit_events_team_at on audit_events (team_id, at desc, id desc) where team_id is not null;
