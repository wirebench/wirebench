-- Wirebench Server 0019: local-agent pairing (hosted edition spec §18.2). A browser user asks for a short
-- code; the agent trades it for a pairing that holds its Ed25519 public key. Before serving a tab, the agent
-- redeems the single-use nonce the server gave that tab. Codes are stored as an HMAC and nonces as a hash,
-- and both are taken with `delete … returning`, so each is used once; the daily sweep deletes the expired
-- ones. No `tenant_id` yet: slice 4 adds it to every table at once.
create table agent_pairings (
  id           text primary key,
  user_id      text not null references users (id) on delete cascade,
  agent_id     text not null,
  public_key   text not null,
  port         integer not null check (port between 1 and 65535),
  ssh_opt_in   boolean not null,
  created_at   timestamptz not null,
  last_seen_at timestamptz not null,
  -- One pairing per agent install and user: pairing again replaces the key and the port.
  unique (user_id, agent_id)
);

-- One live code per user, keyed by an HMAC of the code. A wrong guess matches no row, so it cannot be
-- counted against a code; the per-address and server-wide limits on failed pairings bound guessing instead.
create table agent_pairing_codes (
  code_hash  text primary key,
  user_id    text not null unique references users (id) on delete cascade,
  expires_at timestamptz not null
);

-- A tab's nonce, bound to the pairing and the user it was issued for.
create table agent_nonces (
  nonce_hash text primary key,
  pairing_id text not null references agent_pairings (id) on delete cascade,
  user_id    text not null references users (id) on delete cascade,
  expires_at timestamptz not null
);
create index agent_nonces_expires_at on agent_nonces (expires_at);
