-- Wirebench Server 0018: browser sessions (hosted edition spec §17.2). A browser's session cookie holds a
-- device token like the desktop's, with the same idle and maximum ages; `kind` tells the two apart so
-- the guard only accepts a browser token from the cookie. `browser_flows` keeps an OIDC or SAML sign-in
-- started from the browser until its callback returns; the state is stored hashed, and the daily
-- sweep deletes the expired rows.
alter table device_tokens add column kind text not null default 'device' check (kind in ('device', 'browser'));

create table browser_flows (
  id            text primary key,
  provider      text not null check (provider in ('oidc', 'saml')),
  state_hash    text not null unique,
  nonce         text,
  code_verifier text,
  redirect_to   text not null,
  expires_at    timestamptz not null,
  created_at    timestamptz not null default now()
);
