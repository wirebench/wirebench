-- Wirebench Server 0017: the workspace feature policy (feature switches phase 4, ADR-0029). A workspace
-- admin lists the feature ids that are off for everyone on the workspace; the list can only switch
-- features off, never on, so an empty list is no policy and an older desktop reading it loses nothing.
alter table workspaces add column disabled_features text[] not null default '{}';
