-- Wirebench Server 0026: two-step sign-in (two-step sign-in spec §7). Four tables, scoped as 0021 scopes its
-- tables: `tenant_id` defaulting to the setting, first in every key, then `tenant_scope()`.
--
-- - `identity_totp`: a person's authenticator secret, sealed under a key derived from the tenant's data key and the
--   person (`identity/two-factor/keys.ts`). Pending until `confirmed_at`; `last_step` is the last 30-second step a code
--   was accepted for, so no code is accepted twice.
-- - `identity_passkeys`: WebAuthn credentials, at most ten a person (the route's limit). `counter` is the
--   authenticator's signature counter.
-- - `identity_recovery_codes`: HMAC hashes of the person's ten one-use codes.
-- - `identity_two_factor_challenges`: a password sign-in waiting for its second step (`sign-in`), or for its first
--   method under the required switch (`setup`), five minutes, one use, its secret stored hashed; the desktop's passkey
--   hand-off keeps its flow on the same row (plan ruling 4). A signed-in person's passkey registration keeps its
--   WebAuthn challenge here too (`register`), with no device. The daily sweep deletes the expired rows.
--
-- New tables only: no row of an existing table is rewritten.

create table identity_totp (
  tenant_id     uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                  references tenants (id),
  user_id       text not null,
  sealed_secret bytea not null,
  confirmed_at  timestamptz,
  last_step     bigint not null default 0,
  created_at    timestamptz not null default now(),
  constraint identity_totp_pkey primary key (tenant_id, user_id),
  constraint identity_totp_user_id_fkey foreign key (tenant_id, user_id)
    references users (tenant_id, id) on delete cascade
);

create table identity_passkeys (
  tenant_id     uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                  references tenants (id),
  id            text not null,
  user_id       text not null,
  credential_id bytea not null,
  public_key    bytea not null,
  counter       bigint not null default 0,
  transports    text[] not null default '{}',
  name          text not null,
  created_at    timestamptz not null default now(),
  last_used_at  timestamptz,
  constraint identity_passkeys_pkey primary key (tenant_id, id),
  constraint identity_passkeys_credential_id_key unique (tenant_id, credential_id),
  constraint identity_passkeys_user_id_fkey foreign key (tenant_id, user_id)
    references users (tenant_id, id) on delete cascade
);
create index identity_passkeys_user_id on identity_passkeys (tenant_id, user_id);

create table identity_recovery_codes (
  tenant_id  uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
               references tenants (id),
  user_id    text not null,
  code_hash  text not null,
  used_at    timestamptz,
  created_at timestamptz not null default now(),
  constraint identity_recovery_codes_pkey primary key (tenant_id, user_id, code_hash),
  constraint identity_recovery_codes_user_id_fkey foreign key (tenant_id, user_id)
    references users (tenant_id, id) on delete cascade
);

create table identity_two_factor_challenges (
  tenant_id          uuid not null default nullif(current_setting('wirebench.tenant_id', true), '')::uuid
                       references tenants (id),
  id                 text not null,
  user_id            text not null,
  secret_hash        text not null,
  purpose            text not null check (purpose in ('sign-in', 'setup', 'register')),
  device_name        text,
  token_kind         text check (token_kind in ('device', 'browser')),
  webauthn_challenge text,
  attempts           integer not null default 0,
  flow_id            text,
  code_challenge     text,
  loopback_port      integer,
  grant_hash         text,
  created_at         timestamptz not null default now(),
  expires_at         timestamptz not null,
  constraint identity_two_factor_challenges_pkey primary key (tenant_id, id),
  constraint identity_two_factor_challenges_secret_hash_key unique (tenant_id, secret_hash),
  constraint identity_two_factor_challenges_flow_id_key unique (tenant_id, flow_id),
  constraint identity_two_factor_challenges_user_id_fkey foreign key (tenant_id, user_id)
    references users (tenant_id, id) on delete cascade
);

select tenant_scope('identity_totp'::regclass);
select tenant_scope('identity_passkeys'::regclass);
select tenant_scope('identity_recovery_codes'::regclass);
select tenant_scope('identity_two_factor_challenges'::regclass);
