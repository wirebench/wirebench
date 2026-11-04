-- Wirebench Server 0023: the control plane (hosted edition spec §22.3, ADR-0039). The tenants' billing and lifecycle
-- columns, the four tables only the control plane reads and writes, and the three per-tenant tables it keeps.
--
-- - `tenants` gains where its edition comes from, why and since when it is suspended, and who asked for its deletion
--   and when. Every existing row keeps the defaults: `license`, not suspended, no deletion asked for.
-- - `tenant_slugs_retired`, `signups`, `billing_events` and `tenant_deletions` are unscoped (guard 3's allowlist,
--   §19.8): a signup has no tenant yet, a provider event names a subscription, and a deletion's record outlives its
--   tenant. The control role holds select, insert, update and delete on them; the app role holds nothing, since
--   `admin tenancy role`'s grants revoke what the owner's default privileges give it (`tenancy/grants.ts`).
-- - `subscriptions`, `tenant_exports` and `tenant_settings` are scoped as 0021 scopes its tables: `tenant_id uuid not
--   null` defaulting to the setting and referencing `tenants`, first in every key, then `tenant_scope()`, which forces
--   row-level security under the one `tenant_isolation` policy.
--
-- New columns with constant defaults and new tables: no row of an existing table is rewritten.

alter table tenants
  add column edition_source text not null default 'license'
    check (edition_source in ('license', 'subscription', 'operator')),
  add column suspended_reason text check (suspended_reason in ('unpaid', 'canceled', 'operator', 'importing')),
  add column suspended_at timestamptz,
  add column deletion_requested_at timestamptz,
  -- 'operator' or a user id; `deleting_at` is when the job runs.
  add column deletion_requested_by text;

create table tenant_slugs_retired (
  slug            text primary key,
  tenant_id       uuid not null,
  retired_at      timestamptz not null default now(),
  redirect_to     text,
  redirect_until  timestamptz
);

create table signups (
  id             uuid primary key,
  email_lower    text not null,
  name           text not null,
  slug           text not null,
  seats          integer not null,
  token_hash     text not null unique,
  password_hash  text,
  status         text not null default 'pending' check (status in ('pending', 'verified', 'completed')),
  tenant_id      uuid,
  created_at     timestamptz not null default now(),
  expires_at     timestamptz not null
);
create unique index signups_slug_open on signups (slug) where status <> 'completed';

create table billing_events (
  provider     text not null,
  event_id     text not null,
  event_type   text not null,
  occurred_at  timestamptz not null,
  received_at  timestamptz not null default now(),
  outcome      text not null,
  primary key (provider, event_id)
);

create table tenant_deletions (
  tenant_id     uuid primary key,
  slug          text not null,
  requested_at  timestamptz not null,
  deleted_at    timestamptz not null,
  chain_seq     bigint,
  chain_hash    text,
  chain_key_id  text
);

create table subscriptions (
  tenant_id           uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                        references tenants (id),
  provider            text not null,
  provider_ref        text not null,
  customer_ref        text,
  plan                text not null,
  seats               integer not null,
  status              text not null,
  current_period_end  timestamptz,
  past_due_since      timestamptz,
  last_event_at       timestamptz not null,
  constraint subscriptions_pkey primary key (tenant_id)
);
create unique index subscriptions_ref on subscriptions (tenant_id, provider, provider_ref);

create table tenant_exports (
  tenant_id     uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                  references tenants (id),
  id            text not null,
  requested_by  text not null,
  status        text not null,
  size_bytes    bigint,
  sha256        text,
  error         text,
  requested_at  timestamptz not null default now(),
  ready_at      timestamptz,
  expires_at    timestamptz,
  constraint tenant_exports_pkey primary key (tenant_id, id)
);

create table tenant_settings (
  tenant_id   uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                references tenants (id),
  section     text not null,
  value       jsonb not null,
  sealed      bytea,
  updated_at  timestamptz not null default now(),
  updated_by  text not null,
  constraint tenant_settings_pkey primary key (tenant_id, section)
);

select tenant_scope('subscriptions'::regclass);
select tenant_scope('tenant_exports'::regclass);
select tenant_scope('tenant_settings'::regclass);
