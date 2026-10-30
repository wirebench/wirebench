-- The two roles the server's integration suite connects as (hosted edition spec §19.4, §19.13):
-- wirebench_owner owns each test file's schema and runs the migrations, standing for a managed
-- database's owner role; wirebench_app runs every query. Neither is a superuser or bypasses row-level
-- security, so no isolation test can pass because a policy does not apply.
--
-- Run as the service's superuser. Idempotent: roles are cluster-wide, and a second run, or a run on a
-- cluster where they already exist, only puts their attributes and test passwords back. The passwords
-- are fixed test credentials, the ones packages/server/test/helpers/database.ts derives its URLs with.
do $roles$
begin
  if not exists (select from pg_roles where rolname = 'wirebench_owner') then
    create role wirebench_owner;
  end if;
  if not exists (select from pg_roles where rolname = 'wirebench_app') then
    create role wirebench_app;
  end if;
end
$roles$;

alter role wirebench_owner login nosuperuser nobypassrls nocreaterole nocreatedb password 'wirebench_owner';
alter role wirebench_app login nosuperuser nobypassrls nocreaterole nocreatedb noinherit password 'wirebench_app';
