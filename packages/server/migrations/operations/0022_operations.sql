-- Wirebench Server 0022: operations (hosted edition spec §20.2, §20.6, §20.7). The tables that let several
-- instances of the server share one database: who is running, the rate-limit buckets, the per-tenant send slots, and
-- which instance holds each terminal share.
--
-- - `server_instances` is unscoped, like `server_identity`: it names processes, not tenants (guard 3's allowlist,
--   §19.8). The app role gets select, insert, update and delete on it from `admin tenancy role`'s grants and from
--   the owner's default privileges, as on every table that is not read-only.
-- - The other three are scoped as 0021 scopes its tables: `tenant_id uuid not null` defaulting to the setting and
--   referencing `tenants`, first in the primary key, then `tenant_scope()`, which forces row-level security under
--   the one `tenant_isolation` policy.
-- - The buckets and the send slots are unlogged: after a crash they start empty, so every bucket is full again, as an
--   in-memory limiter is after a restart, and every slot is free. Nothing in them outlives the processes using it.
--
-- New tables only: no row of an existing table is read or written.

create table server_instances (
  holder      uuid primary key,
  url         text,
  version     text not null,
  started_at  timestamptz not null default now(),
  renewed_at  timestamptz not null default now()
);

create unlogged table limiter_buckets (
  tenant_id   uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                references tenants (id),
  key         text not null,
  tokens      double precision not null,
  updated_at  timestamptz not null,
  constraint limiter_buckets_pkey primary key (tenant_id, key)
);

create unlogged table send_slots (
  tenant_id   uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                references tenants (id),
  slot        smallint not null,
  holder      uuid not null,
  expires_at  timestamptz not null,
  constraint send_slots_pkey primary key (tenant_id, slot)
);

create table terminal_share_locations (
  tenant_id   uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                references tenants (id),
  share_id    text not null,
  holder      uuid not null,
  created_at  timestamptz not null default now(),
  constraint terminal_share_locations_pkey primary key (tenant_id, share_id)
);

select tenant_scope('limiter_buckets'::regclass);
select tenant_scope('send_slots'::regclass);
select tenant_scope('terminal_share_locations'::regclass);
