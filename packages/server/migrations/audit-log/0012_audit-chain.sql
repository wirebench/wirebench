-- Wirebench Server 0012: the audit chain (issue #210). A background sealer links committed rows with a
-- keyed hash: chain_seq is a row's gapless place in the chain and chain_hash its link; both stay null
-- until the row is sealed. The one-row anchor holds the (seq, hash) just before the oldest kept row and
-- the id of the key that built the chain, and head_seq, the highest sequence number ever sealed, so a
-- chain whose rows were removed from outside resumes past the gap instead of reusing numbers. mac is a
-- keyed MAC over (seq, hash, head_seq), set by every write of the row, so the anchor cannot be moved or
-- its head_seq lowered without the key. Migration rule: from here on no migration may update sealed audit_events rows.
alter table audit_events add column chain_seq bigint, add column chain_hash bytea;
create unique index audit_events_chain_seq on audit_events (chain_seq) where chain_seq is not null;
create index audit_events_unsealed on audit_events (at, id) where chain_seq is null;
create table audit_chain_anchor (
  only_row boolean primary key default true check (only_row),
  seq      bigint not null,
  hash     bytea  not null,
  key_id   text   not null,
  head_seq bigint not null default 0,
  mac      bytea  not null
);
