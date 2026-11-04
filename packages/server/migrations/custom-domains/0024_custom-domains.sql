-- Wirebench Server 0024: custom domains (hosted edition spec §23.3). One custom name per tenant, and the routing
-- table that says which tenant holds which name.
--
-- - `custom_domains` is scoped as 0021 scopes its tables: `tenant_id uuid not null` defaulting to the setting and
--   referencing `tenants`, then `tenant_scope()`, which forces row-level security under the one `tenant_isolation`
--   policy. Its primary key is `tenant_id` alone, which is the one-name-per-tenant rule (§23.1). `created_by` names a
--   user by id with no foreign key, as the audit log does: the claim outlives its author, and an operator's command
--   has none. `last_result` is `{ cname, txt, certificate, message }`; the token appears nowhere but `token`.
-- - `tenant_hosts` is unscoped, the custom-name counterpart of `tenants.slug`: routing only, no tenant content
--   (guard 3's allowlist, §19.8). Its primary key on `host` is what lets exactly one tenant hold a name. The app role
--   gets select, insert, update and delete on it from `admin tenancy role`'s grants and from the owner's default
--   privileges, as on every table that is not read-only. A deleted tenant's hosts go with it.
--
-- New tables only: no row of an existing table is read or written.

create table custom_domains (
  tenant_id      uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                   references tenants (id),
  name           text not null,
  token          text not null,
  state          text not null default 'pending',
  created_by     text,
  created_at     timestamptz not null default now(),
  checked_at     timestamptz,
  verified_at    timestamptz,
  active_at      timestamptz,
  failing_since  timestamptz,
  last_result    jsonb,
  constraint custom_domains_pkey primary key (tenant_id),
  constraint custom_domains_state_check
    check (state in ('pending', 'verified', 'active', 'failing', 'lapsed', 'paused', 'expired'))
);

create table tenant_hosts (
  host       text primary key,
  tenant_id  uuid not null references tenants (id) on delete cascade,
  live       boolean not null default false,
  since      timestamptz not null default now(),
  -- A lower-case domain name of two labels or more, each 1 to 63 letters, digits or inner hyphens, at most 253 in
  -- all: no scheme, port, path, trailing dot or `*`. An all-digit last label (an IPv4 literal) is refused too.
  constraint tenant_hosts_host_check check (
    length(host) <= 253
    and host ~ '^([a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?\.)+[a-z0-9]([a-z0-9-]{0,61}[a-z0-9])?$'
    and host !~ '\.[0-9]+$'
  )
);

select tenant_scope('custom_domains'::regclass);
