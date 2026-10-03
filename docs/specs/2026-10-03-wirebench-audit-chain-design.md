# Wirebench: hash-chaining the audit log — design

Date: 2026-10-03 · Status: design approved by the owner in conversation 2026-10-03 · Module: `audit-log`
(issue #210, epic #199)

- **Builds on:**
  - `docs/specs/2026-10-01-wirebench-server-audit-log-design.md`: the `audit_events` table, the audit hook, retention (§3.3) and the command line (§3.5).
  - The forwarder from `docs/plans/2026-10-03-wirebench-audit-forwarding-plan.md`, the model for a background loop that claims rows in batches.
- **Decisions recorded here** (owner, 2026-10-03, popup):
  - **Seal shortly after the commit, not inside the action's transaction.** Linking a row needs the previous row's hash, so linking in the recording transaction would make every audited action wait for the one before it to commit. A background sealer links committed rows instead. A row is unprotected for the few seconds until it is sealed.
  - **The chain uses a keyed hash.** Each link is an HMAC-SHA256 with a key kept outside the database, so someone who can write the table cannot rebuild the chain after editing a row.
  - **On whenever the key is set, on every edition.** Like recording, sealing needs no license; nothing pauses or resumes. Verifying is a command-line tool for whoever has the box.
  - **Cutting off the newest rows is caught through the server log.** After each sealing batch the server logs the new head. The log lives outside the database, and verify can check a head taken from it.

## Assumptions I'm making

1. **The attacker has database write access but not the key.** They can edit, delete or reorder rows and change the new columns. Someone with both the database and the key can rewrite history; the chain does not claim to stop them.
2. **The key is managed like the other server secrets.** It comes from the environment (or a secret store that fills it). Losing it means old rows can no longer be verified. Changing it is a rotation, and rotation is out of scope (§1.2).
3. **No migration updates a sealed row.** The 0010 team backfill ran before any row could be sealed. From now on, a migration that rewrites `audit_events` would break the chain, and the migration rules say so.
4. **One chain per server database.** Several server instances on one database share it; an advisory lock keeps one sealer at a time.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

Make any edit, deletion or reordering of audit rows detectable, as auditors ask, without slowing or serialising the actions that record them.

### 1.1 In scope

- Two chain columns on `audit_events` and a one-row anchor table (migration 0012).
- An `AuditSealer` loop in the `audit-log` module, on when `WIREBENCH_SERVER_AUDIT_CHAIN_KEY` is set.
- Retention that keeps the chain verifiable from the oldest kept row.
- `wirebench-server admin audit verify [--head <seq>:<hex>]`.
- A head log line after each sealing batch.

### 1.2 Not in scope

- **Key rotation.** A changed key is refused (§3.2); the guide says to keep the key.
- **Carrying the hash or sequence number in exports or forwarded events.**
- **A head file, or another outside store for heads.** The server log is the outside copy.
- **A read route or desktop view for chain status.** Verify is a command-line tool.

## 2. Concept model

- **Sealed row:** an `audit_events` row with `chain_seq` and `chain_hash` set. An unsealed row has both null.
- **Sequence number (`chain_seq`):** the row's place in the chain, given at sealing and gapless from the anchor. The chain is ordered by sequence number, not by `at`: a row whose transaction commits late gets a later number than rows with a later `at`.
- **Link (`chain_hash`):** `HMAC-SHA256(key, prev_hash ‖ seq ‖ canonical row)`, where `prev_hash` is the hash of the row with `seq − 1`, or the anchor's hash.
- **Anchor:** the chain's starting point. It holds the sequence number and hash just before the oldest kept row, plus the key's id. At first sealing it is the genesis: `seq` 0 and `hash = HMAC-SHA256(key, "wirebench-audit-chain-genesis")`.
- **Head:** the highest sealed `(seq, hash)`.
- **Key id:** the first 8 bytes of `SHA-256(key)`, in hex. It tells a wrong key apart from a tampered chain. It is not secret.

## 3. Behaviour

### 3.1 Configuration

`WIREBENCH_SERVER_AUDIT_CHAIN_KEY`:
- optional, `secret: true`, at least 32 characters, used as UTF-8 bytes;
- unset means no sealing, and retention works as today (§3.3);
- shorter than 32 characters is a config error, phrased without the value.

### 3.2 Sealing

`AuditSealer`, with the shape of the forwarder (`start`, `stop`, `runOnce`, injected `setTimer`), started by the `audit-log` module when the key is set.

**Each pass is one transaction:**

1. `select pg_try_advisory_xact_lock(<audit chain lock id>)`. If another instance holds the lock, the pass ends as `busy-elsewhere` and the sealer tries again at the idle delay.
2. Read the anchor; if there is none, insert the genesis anchor with this key's id.
3. Check the key. If the anchor's key id differs from this key's id, refuse to seal. Log one `error` (`audit chain key does not match the chain's key id <id>`), re-arm at the idle delay, and log again only after the key changes and fails again. Inserts are never affected.
4. The head is `max(chain_seq)`, or the anchor when nothing is sealed.
5. Claim up to **500** unsealed rows: `where chain_seq is null order by at, id limit 500 for update skip locked`. Uncommitted rows are invisible, so only committed rows are sealed.
6. For each row in that order: `seq = head.seq + 1`, then `hash = HMAC(key, head.hash ‖ seq ‖ canonical(row))`. Update the row and advance the head.
7. Commit. If the batch sealed anything, log at `info`: `audit chain sealed to <seq>:<hash hex>` with `{ sealed: n }`.

**Canonical row:**
- Postgres renders the columns as text and Node builds the hash, so the key never reaches the database.
- Columns, in a fixed order, each written as its length in bytes, a colon, then the value (`len:value`):
  - `id`;
  - `at` as `to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;
  - `actor_kind`, `actor_user_id`, `actor_email`, `actor_token_id`, `actor_workspace_id`;
  - `action`, `target_kind`, `target_id`;
  - `workspace_id`, `team_id`;
  - `host(ip)`, `user_agent`;
  - `details::text`.
- A null is written as `-1:`.
- `seq` is written as 8 big-endian bytes, and `prev_hash` as its 32 raw bytes.
- `jsonb` text output is normalised by Postgres (key order, whitespace), so the same `details` always hashes the same.

**Timing:**
- Every **2 s** while the last pass sealed something, every **5 s** when idle.
- After an unexpected error it backs off from 5 s, doubling, to 300 s. It logs one `warn` when it starts failing and one `info` when it recovers.
- It stops from `onClose`, before the sweeper, and a pass under way finishes.

**Exposure window:** a row is unsealed from its commit until the next pass, normally under 5 s. Verify reports unsealed rows separately and never treats them as broken.

### 3.3 Retention

**With the key set:**
- The sweeper deletes only sealed rows, and only from the oldest end of the chain, so the kept chain stays gapless.
- On each batch it finds `S`, the highest sequence number whose row and every row before it are older than the cutoff: `S = (min chain_seq where at >= cutoff) − 1`, or `max(chain_seq)` when no sealed row is that new.
- It deletes `chain_seq <= least(S, anchor.seq + 1000)`, oldest first. In the same transaction it moves the anchor to the last deleted row's `(seq, hash)`. The key id stays.
- Unsealed rows past the cutoff stay until they are sealed.
- A row that commits late with an old `at` can hold back deletion of the rows sealed after it until it, too, is past the cutoff. That costs a little extra storage, never a gap.

**Without the key:** retention is unchanged, deleting by `at`. If the key is set later, sealing starts from the rows still present. If the key is unset later, rows stay sealed and new rows stay unsealed until it is set again. If any rows were deleted while the key was unset, the next verify reports a gap.

**Unchanged:** the forward queue cascade, and the rule that the sweep is not itself an event.

### 3.4 Verify

`wirebench-server admin audit verify [--head <seq>:<hex>]`.

**Setup:** it reads the key from `WIREBENCH_SERVER_AUDIT_CHAIN_KEY`. With no key, it exits 2 with a config error. It needs no license.

**The walk:**
- It reads the anchor and compares key ids. A mismatch is reported as `wrong key (chain key id <id>)`, exit 2.
- It walks the sealed rows in `chain_seq` order, 1000 at a time, recomputing each link from the anchor.
- It stops at the first broken link and reports its sequence number, the row id when there is one, and the reason:
  - `edited`: the hash does not match the row's content. An edited sequence number or hash, a swapped row and an edited anchor all show up here or as a gap.
  - `missing`: a sequence number is skipped. A deleted row lands here.
  - `out of order`: a sequence number repeats or goes backwards.

**`--head <seq>:<hex>`:** a head copied from the server log must exist with exactly that hash. Otherwise it reports `head <seq> not found: newer rows were removed` or `head <seq> does not match`.

**Output:** a short human-readable summary on stdout:
- the rows checked, the first and last sequence numbers, and the number of unsealed rows;
- the broken link, if there is one.

`--json` prints the same summary as one JSON object.

**Exit codes:** 0 intact, 1 broken, 2 config error or wrong key.

**Record:** it records `audit.verified` with `actor: system` and details `{ checked, firstSeq, lastSeq, unsealed, result: 'intact' | 'broken', brokenSeq? }`. The event is recorded after the walk, so it is itself sealed later.

### 3.5 What an operator sees

The audit-log guide gains a *Tamper evidence* section:
- the variable, and how to keep the key;
- the head log line, and why to keep logs elsewhere;
- verify, with an example run and the exit codes;
- what the chain does and does not detect (assumption 1);
- the exposure window.

The configuration reference gains the variable, generated from `config.ts`.

## 4. Data model and storage

Migration `packages/server/migrations/audit-log/0012_audit-chain.sql`:

```sql
alter table audit_events add column chain_seq bigint, add column chain_hash bytea;
create unique index audit_events_chain_seq on audit_events (chain_seq) where chain_seq is not null;
create index audit_events_unsealed on audit_events (at, id) where chain_seq is null;
create table audit_chain_anchor (
  only_row boolean primary key default true check (only_row),
  seq      bigint not null,
  hash     bytea  not null,
  key_id   text   not null
);
```

Existing rows start unsealed. With a key set they are sealed oldest first on the first passes, 500 at a time.

## 5. Architecture

- `packages/server/src/audit-log/chain/`:
  - `canonical.ts`: the canonical bytes of a row and the link function. Pure, and unit-tested against fixed vectors.
  - `sealer.ts`: `AuditSealer`.
  - `verify.ts`: the walk, shared by the command line.
- `repo.ts`:
  - `readAnchor`, `insertGenesis`, `chainHead`, `claimUnsealed(tx, limit)`, `sealRow(tx, id, seq, hash)`;
  - `sealedPage(db, afterSeq, limit)`;
  - `deleteSealedBefore(db, cutoff, limit)`, which moves the anchor.
- `module.ts`: build and start the sealer when the key is set. Hand the sweeper `deleteSealedBefore` in place of `deleteAuditEventsBefore`. On close, stop the sealer before the sweeper.
- `identity/cli.ts` (where `admin audit export` lives): `admin audit verify`.
- `config.ts`: `auditChainKey`.

## 6. Security

- The key never leaves the server process: not written to the database, not logged, not in errors.
- The key id is a truncated hash of the key, so revealing it does not help forge links.
- A database-only attacker (assumption 1) cannot:
  - edit, delete or reorder a sealed row without verify catching it;
  - delete the newest sealed rows without a `--head` check from the log catching it;
  - move or edit the anchor without verify catching it, because the first kept row's link no longer matches.
- They can delete or edit rows in the unsealed window. The window is documented.
- They can also delete everything, chain and anchor together. Verify then reports an empty chain, which `--head` catches.

## 7. Testing

- **Unit:** canonical bytes for a fixed row, including nulls, multi-byte text, `details` key order and a microsecond `at`; links against fixed vectors.
- **Integration (Postgres, injected timers):**
  - Sealing:
    - rows are sealed in claim order with gapless sequence numbers;
    - a row committed late with an earlier `at` is sealed after rows already sealed;
    - a row inserted inside a transaction left open during a pass is not sealed until it commits;
    - two sealers on one database never assign the same sequence number;
    - a wrong key is refused with one error log, and nothing is sealed;
    - with no key, nothing is sealed.
  - Verify:
    - it reports `edited` for an edited row, a changed `details` key and an edited anchor;
    - it reports `missing` for a deleted middle row;
    - it reports a broken link when two rows' sequence numbers are swapped;
    - `--head` reports newer rows removed when the tail is deleted;
    - unsealed rows are counted and not treated as broken;
    - each exit code is covered.
  - Retention:
    - after sweeping, verify is intact from the new anchor;
    - an unsealed old row is not deleted;
    - a late old row holds back deletion without a gap.
- **Concurrency:** a burst of audited actions in parallel transactions completes while the sealer runs, and no action waits on the sealer's lock. The sealer's lock is advisory and taken only by sealers.
- The migration-list test covers `12_audit-chain`.

## 8. Commands

`WIREBENCH_SKIP_PERF=1 pnpm check` with the Postgres test URL; `pnpm test:perf` before a push.

## 9. Open questions

None.
