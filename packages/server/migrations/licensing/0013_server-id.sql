-- Wirebench Server 0013: the server id a license may be bound to (license-binding spec §3.1, §4).
-- Minted here, once, so it exists before serve or any admin command reads it. Nothing updates or deletes
-- the row; a restore from backup keeps it, so a license follows its server to new hardware.
create table server_identity (
  singleton  boolean primary key default true check (singleton),
  server_id  uuid not null,
  created_at timestamptz not null default now()
);
insert into server_identity (server_id) values (gen_random_uuid());
