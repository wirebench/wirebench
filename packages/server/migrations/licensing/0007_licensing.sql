-- packages/server/migrations/licensing/0007_licensing.sql
-- Wirebench Server 0007: the license (licensing spec §4.2). One row at most, enforced by the singleton
-- key. The raw text is stored, not parsed fields, so a later server version re-verifies it with its
-- own keys and schema. license_id is kept beside it for the audit log and `admin license show`.
create table license (
  singleton    boolean primary key default true check (singleton),
  text         text not null,
  license_id   text not null,
  installed_by text references users on delete set null,
  installed_at timestamptz not null default now()
);
