-- Wirebench Server 0009: whether desktops report request and run metadata for a workspace (#211).
-- Off by default; a workspace admin turns it on.
alter table workspaces add column record_desktop_activity boolean not null default false;
