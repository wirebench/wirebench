-- The three roles the server's integration suite connects as (hosted edition spec §19.4, §19.13, §22.2):
-- wirebench_owner owns each test file's schema and runs the migrations, standing for a managed
-- database's owner role; wirebench_app runs every query. Neither is a superuser or bypasses row-level
-- security, so no isolation test can pass because a policy does not apply. wirebench_control is the
-- hosted control plane's role, the one that bypasses the policy; only the control-role tests connect as it.
--
-- Run as the service's superuser: only a superuser (or a role that has BYPASSRLS itself) may give a role
-- BYPASSRLS. Idempotent: roles are cluster-wide, and a second run, or a run on a cluster where they already
-- exist, only puts their attributes and test passwords back. The passwords are fixed test credentials, the
-- ones packages/server/test/helpers/database.ts derives its URLs with.
do $roles$
begin
  if not exists (select from pg_roles where rolname = 'wirebench_owner') then
    create role wirebench_owner;
  end if;
  if not exists (select from pg_roles where rolname = 'wirebench_app') then
    create role wirebench_app;
  end if;
  if not exists (select from pg_roles where rolname = 'wirebench_control') then
    create role wirebench_control;
  end if;
end
$roles$;

alter role wirebench_owner login nosuperuser nobypassrls nocreaterole nocreatedb password 'wirebench_owner';
alter role wirebench_app login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password 'wirebench_app';
alter role wirebench_control login nosuperuser bypassrls nocreaterole nocreatedb noinherit password 'wirebench_control';
