-- Wirebench Server 0003: teams, membership, workspace ownership and grants (teams-access spec §4.1).
-- `workspaces.team_id` is added not null without a default, which only works on an empty table:
-- no module wrote workspace rows before this one, and the first statement makes that a checked
-- precondition rather than an assumption.
do $$
begin
  if exists (select 1 from workspaces) then
    raise exception '0003_teams needs an empty workspaces table';
  end if;
end
$$;

create table teams (
  id         text primary key,
  name       text not null,
  created_at timestamptz not null default now()
);
-- Names are unique per server regardless of case (R8).
create unique index teams_name_lower on teams (lower(name));

create table team_members (
  team_id  text not null references teams on delete cascade,
  user_id  text not null references users on delete cascade,
  role     text not null check (role in ('admin', 'member')),
  added_at timestamptz not null default now(),
  primary key (team_id, user_id)
);
create index team_members_user_id on team_members (user_id);

-- A team invitation is an identity invitation plus the team and the role it grants (§3.4).
create table team_invitations (
  invitation_id text primary key references invitations on delete cascade,
  team_id       text not null references teams on delete cascade,
  role          text not null check (role in ('admin', 'member'))
);
create index team_invitations_team_id on team_invitations (team_id);

alter table workspaces
  add column team_id      text not null references teams on delete restrict,
  add column default_role text not null default 'viewer' check (default_role in ('none', 'viewer', 'editor')),
  add column created_by   text references users on delete set null;
create unique index workspaces_team_name_lower on workspaces (team_id, lower(name));

create table workspace_grants (
  workspace_id text not null references workspaces on delete cascade,
  user_id      text not null references users on delete cascade,
  role         text not null check (role in ('viewer', 'editor', 'admin')),
  granted_at   timestamptz not null default now(),
  primary key (workspace_id, user_id)
);
create index workspace_grants_user_id on workspace_grants (user_id);
