# Hash-chaining the audit log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Make any edit, deletion or reordering of Wirebench Server audit rows detectable. A background sealer links committed rows with a keyed HMAC; `wirebench-server admin audit verify` reports the first broken link.

**Architecture:** Migration 0012 adds `chain_seq` and `chain_hash` to `audit_events`, and a one-row `audit_chain_anchor` table. An `AuditSealer` in the `audit-log` module seals committed rows in batches under an advisory lock. Retention deletes only sealed rows from the oldest end and moves the anchor. Verify walks the chain from the anchor. Inserts are unchanged.

**Tech Stack:** TypeScript on Node 24, Fastify, Postgres (`pg`), `node:crypto` (HMAC-SHA256), zod 4, Vitest 5.

**Spec:** `docs/specs/2026-10-03-wirebench-audit-chain-design.md` is binding: its exact values, formats, messages and exit codes are used verbatim. Issue #210.

## Global Constraints

- **Config:** `WIREBENCH_SERVER_AUDIT_CHAIN_KEY` is optional, `secret: true`, and at least 32 characters. A shorter key is a config error that does not echo the value. Add it to both the zod schema and the documented variable list in `packages/server/src/config.ts`, and regenerate the configuration reference with the existing generator (`docs:server-config`).
- **Key:** the key never reaches the database, a log line or an error. The key id is the first 8 bytes of `SHA-256(key)`, in hex.
- **Link:** `HMAC-SHA256(key, prev_hash(32 raw bytes) ‖ seq(8 bytes, big-endian) ‖ canonical(row))`.
  - **Genesis:** `seq` 0, with `hash = HMAC-SHA256(key, "wirebench-audit-chain-genesis")`.
  - **Canonical row:** every column, in the spec's §3.2 order, written as `len:value`, where `len` is the value's length in UTF-8 bytes; a null is written as `-1:`.
  - **Field forms:** `at` is `to_char(at at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`, `ip` is `abbrev(ip)` (it keeps a netmask other than /32 or /128 and prints a single host bare; ruled in fix round 1 of Task 1) and `details` is `details::text`, all rendered by Postgres.
- **Sealer:**
  - **Batch:** 500 rows per pass.
  - **Timing:** 2 s while busy, 5 s when idle. After an unexpected error, back off from 5 s, doubling, up to 300 s. Log one `warn` when it starts failing and one `info` when it recovers.
  - **Lock:** each pass is one transaction that starts with `pg_try_advisory_xact_lock`, using one constant lock id exported from the sealer module.
  - **Claim:** `where chain_seq is null order by at, id limit 500 for update skip locked`.
  - **Wrong key:** refuse to seal, logging one `error` per distinct key.
  - **Head log line:** `audit chain sealed to <seq>:<hex>` at `info`, with `{ sealed: n }`.
  - **Shutdown:** stop from `onClose`, before the sweeper, finishing the pass under way.
- **Retention with a key:**
  - It deletes only sealed rows, with `chain_seq <= least(S, anchor.seq + 1000)`, where `S = (min chain_seq where at >= cutoff) − 1`, or `max(chain_seq)` when no sealed row is that new.
  - It moves the anchor in the same transaction.
  - Unsealed rows are never deleted.
- **Retention without a key:** unchanged.
- **Verify:**
  - Command: `wirebench-server admin audit verify [--head <seq>:<hex>] [--json]`.
  - **Exit codes:** 0 intact, 1 broken, 2 config error or wrong key.
  - **Reasons:** `edited`, `missing`, `out of order`.
  - **Messages:** `wrong key (chain key id <id>)`, `head <seq> not found: newer rows were removed`, `head <seq> does not match`.
  - **Record:** it records `audit.verified` (`actor: system`) with `{ checked, firstSeq, lastSeq, unsealed, result, brokenSeq? }`.
  - **License:** none needed.
- **Migration:** `packages/server/migrations/audit-log/0012_audit-chain.sql`, exactly as in the spec's §4. The migration-list test (`packages/server/test/integration/teams/migration.test.ts`) gains `12_audit-chain`.
- **Naming:** never name which product inspired a feature (`pnpm check:banned-terms`).
- **Gate:** `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit, with `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`.
- **Commits:** one per task, subject ending `(#210)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e.

## Rulings made while planning

1. **Pure link code:** `canonical.ts` holds pure functions over the text Postgres returns. One SQL select list, `CANONICAL_COLUMNS` in `repo.ts`, produces those texts for both the sealer and verify, so the two can never disagree.
2. **Wrong-key check:** both the sealer and verify compare the anchor's key id before touching any row.
3. **Verify's reasons:**
   - A seq repeating or going backwards is `out of order`.
   - A gap is `missing`.
   - A hash mismatch is `edited`.
   - Swapped seqs show as `edited`, because the seq is part of the link.
4. **Recording `audit.verified`:** it is added to the engine's action list (`packages/engine/src/server-api/audit.ts`, next to `audit.exported`) and recorded by the command line the same way `audit.exported` is.

## Tasks

### Task 1: Config, migration, the link and the repo

**Files:**
- `packages/server/src/config.ts`: `auditChainKey`.
- `packages/server/migrations/audit-log/0012_audit-chain.sql`.
- Create `packages/server/src/audit-log/chain/canonical.ts`:
  - `keyId(key)`;
  - `genesisHash(key)`;
  - `canonicalBytes(row: CanonicalRow)`;
  - `link(key, prevHash: Buffer, seq: bigint, row)`.
- `packages/server/src/audit-log/repo.ts`:
  - `CANONICAL_COLUMNS`;
  - `readAnchor`, `insertGenesis`, `chainHead`, `claimUnsealed(tx, limit)`, `sealRow(tx, id, seq, hash)`, `sealedPage(db, afterSeq, limit)`.

Tests:
- **Config:** a key of 32 characters or more is accepted; a shorter one is refused without echoing it; an unset key is `undefined`.
- **Unit (`test/unit/audit-log/chain/canonical.test.ts`):**
  - canonical bytes for a fixed row: nulls, multi-byte UTF-8, `details` text, a microsecond `at`;
  - a link and a genesis against fixed hex vectors, computed once and pinned;
  - `keyId` is 16 hex characters.
- **Integration:**
  - `CANONICAL_COLUMNS` renders a real row (with `details` keys in a different insertion order, an IPv6 `ip`, a null `team_id`) to the texts the unit test expects;
  - `claimUnsealed` skips sealed rows;
  - the migration list.

- [ ] Write the tests first, then implement, gate and commit `feat(server): the audit chain's link, columns and anchor (#210)`.

### Task 2: The sealer, wired into the module

**Files:**
- Create `packages/server/src/audit-log/chain/sealer.ts`: `AuditSealer`, with deps `{ db, key, now, setTimer, log, batchSize? }` and methods `start()`, `stop()` and `runOnce()`.
- `packages/server/src/audit-log/module.ts`: start the sealer when `ctx.config.auditChainKey` is set; stop it in `onClose` before `sweeper.stop()`.

Tests, in `test/integration/audit-log/chain-sealer.test.ts`, against Postgres with injected timers:
- The first pass inserts the genesis anchor and seals existing rows with gapless seqs from 1, in `(at, id)` order.
- Recomputing every link with `canonical.ts` matches `chain_hash`.
- A row committed late, with an `at` earlier than rows already sealed, gets the next seq.
- A row inside a transaction still open during a pass is not sealed, and the next pass after its commit seals it.
- Two sealers on one database running passes concurrently never assign the same seq; the loser's pass ends `busy-elsewhere`.
- An anchor with a different key id leaves every row unsealed and logs one `error`; a second pass does not log again.
- The head line is logged at `info` after a batch that sealed something, and not after an empty one.
- Delays: 2 s busy, 5 s idle, and backoff after a thrown error.
- Through a running server (`licensingHarness` with the key in env): a real action's event is sealed after one fired pass. Without the key, nothing is sealed and no sealer timer is armed.
- **Concurrency:** 20 audited actions in parallel transactions all complete while a pass holds its lock, and afterwards all are sealed.

- [ ] Write the tests first, then implement, gate and commit `feat(server): seal audit events into a keyed chain (#210)`.

### Task 3: Retention keeps the chain verifiable

**Files:**
- `packages/server/src/audit-log/repo.ts`: `deleteSealedBefore(db, cutoff, limit)`. It deletes the qualifying rows and moves the anchor to the last deleted row's `(seq, hash)` in one transaction.
- `packages/server/src/audit-log/module.ts`: hand the sweeper `deleteSealedBefore` when the key is set, and `deleteAuditEventsBefore` otherwise.

Tests, in `test/integration/audit-log/chain-retention.test.ts`:
- Old sealed rows are deleted and the anchor equals the last deleted row's seq and hash.
- Recomputing from the new anchor over the kept rows matches.
- An unsealed old row is not deleted.
- A late row (old `at`, high seq) holds back deletion of the sealed rows after its seq until it passes the cutoff, and no gap appears.
- The batch limit is respected across repeated calls.
- Without the key, retention deletes by `at` as before (the existing test stays green).

- [ ] Write the tests first, then implement, gate and commit `feat(server): audit retention moves the chain's anchor (#210)`.

### Task 4: `admin audit verify`

**Files:**
- Create `packages/server/src/audit-log/chain/verify.ts`: `verifyChain(db, key, { head? })`, which returns `{ result, checked, firstSeq, lastSeq, unsealed, broken?: { seq, id?, reason } }` or a wrong-key result.
- `packages/server/src/audit-log/cli.ts` and `packages/server/src/identity/cli.ts`: an `admin-audit-verify` case beside `admin-audit-export`, with the flags parsed as the existing commands parse theirs, the text and `--json` output, the exit codes, and recording `audit.verified`.
- `packages/engine/src/server-api/audit.ts`: add the `audit.verified` action.

Tests, in `test/integration/audit-log/chain-verify.test.ts`, after sealing with Task 2's sealer:
- An intact chain gives exit 0, and its summary counts are right.
- An edited `details`, an edited `actor_email` and an edited anchor hash each give `edited` at the right seq, exit 1.
- A deleted middle row gives `missing`.
- Two rows' `chain_seq` values swapped give `edited`.
- A head taken before deleting the two newest rows gives `head <seq> not found: newer rows were removed`; a wrong hex gives `head <seq> does not match`.
- Unsealed rows are counted and not broken.
- A wrong key gives exit 2 with the key id message; no key gives exit 2 with a config error.
- `--json` output parses.
- `audit.verified` is recorded with its details.
- The CLI's output never contains the key.

- [ ] Write the tests first, then implement, gate and commit `feat(server): wirebench-server admin audit verify (#210)`.

### Task 5: Docs

**Files:**
- `docs-site/src/content/docs/guides/server-audit-log.mdx`: a *Tamper evidence* section, per spec §3.5.
- The generated configuration reference (run the generator).
- `packages/server/README.md`: one paragraph in *Audit log*.
- `CHANGELOG.md`: extend the audit-log entry.
- `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` §1.2: point "hash-chaining the log" to the chain spec.

Also add a short rule wherever the server's migration conventions are written (find it), or failing that a comment at the top of `0012_audit-chain.sql`: no migration may update sealed `audit_events` rows.

- [ ] Run `pnpm check:banned-terms` and the docs build, then gate and commit `docs: tamper evidence for the audit log (#210)`.

## After the last task

1. A final review of the #210 range, then one fix wave.
2. `pnpm test:perf`, then push `feat/audit-chain`.
3. Open a PR that closes #210.
4. Merge with `gh pr merge --merge` only when the owner asks.

## Open questions

None.
