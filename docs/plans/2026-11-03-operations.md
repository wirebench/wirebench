# Operations (slice 5 of #776) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** Wirebench Server runs as several instances against one database and one data volume. Live events, tenant
and key changes cross instances through `LISTEN`/`NOTIFY`; repositories are written under an advisory lock; host
sockets stay sticky by the balancer's cookie with the host lease as guard; terminal shares relay between instances;
every rate limit and the new per-tenant budgets live in PostgreSQL; and the server pushes metrics by tenant id over
OpenTelemetry when an endpoint is set. A one-instance self-hosted server behaves as before.

**Architecture:** Three parts, one pull request each, in dependency order.

- **Part A** adds the instance table and the notification bus, and moves every in-memory listener onto it: the hub
  with presence, the host instances, the terminal-share registry, the tenant map and the data-key cache.
- **Part B** adds the advisory repository lock, the shared limiter with every existing limiter moved to it, the
  per-tenant budgets, and draining with `/readyz`.
- **Part C** adds the share relay, the metrics, the two-instance suite, and the docs.

**Tech Stack:** TypeScript (ESM), Fastify 5, `pg` (`LISTEN`/`NOTIFY`, advisory locks, unlogged tables), PostgreSQL 16
(15 at least), `@opentelemetry/api` 1.10.0, `@opentelemetry/sdk-metrics` 3.0.0, `@opentelemetry/resources` 3.0.0,
`@opentelemetry/exporter-metrics-otlp-http` 0.300.0, vitest, Playwright.

**Spec:** `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §5.5, §6, §11 and §20 (which wins where they
differ); ADR-0037; issue #821.

## Global Constraints

- **One code path.** Every mechanism runs in `single` mode too (spec §20.1). `single` differs only in the start-up
  lease delete and in never dialling the relay. No `if (multi)` around the bus, the lock or the limiter.
- **Self-hosted unchanged.** No new variable is needed to start. No route, page or message that a self-hosted user
  sees changes, except `/readyz` (new) and the `4503 host-draining` reason. Old desktops keep working: the bus's
  resync uses `head`, `access` and `presence`, which every desktop already parses (spec §20.3).
- **Hosted mode stays test-only.** `loadConfig` still refuses `WIREBENCH_SERVER_MODE=hosted` (§19.1); tests build a
  hosted `ServerConfig` directly, and hosted configs are always `multi`.
- **Slice 6 is built in parallel** (#822, its own session and branch). Stay out of `tenancy/resolve.ts`,
  `tenancy/urls.ts`, `tenancy/directory.ts`'s slug rules, `tenancy/slugs.ts`, `identity/cookies.ts`, the sign-in and
  invite pages, the `app.` entry and anything about certificates. The resolver's `invalidate()` is called from
  outside `resolve.ts`. The poll interval change (60 s → 10 min, §20.3) goes in as an option `registerTenantResolution`
  already takes, or, if it takes none, as a one-line constant edit, flagged in the PR for slice 6. Expect conflicts
  in `config.ts`, the spec header, `CHANGELOG.md` and `ci.yml`; keep those edits small.
- **Migration `0022`**, under `packages/server/migrations/operations/`, listed in `serve.ts`'s `allMigrations`.
  Slice 6 takes `0023` if it needs one. The tenancy revert (`revert-0020-0021.sql`) refuses to run once `0022` is
  applied, unless it drops `0022`'s tables first: Task 1 decides which and tests it.
- **`check:tenant-scope`** allows `server_instances` and raw `pg_notify`/`LISTEN`/advisory-lock SQL only in
  `src/operations/`. Everything scoped still goes through `withTenant`.
- **New server env vars** follow the config checklist in `packages/server/src/config.ts`, and the server-config docs
  are regenerated (`pnpm docs:server-config`). The `OTEL_*` variables are the SDK's and are documented, not parsed.
- **New dependencies** only in Part C's Task 13, pinned exactly, Apache-2.0, added to
  `scripts/third-party-licenses.ts` before `pnpm install`.
- **Gates:**
  - Commit after every task with `WIREBENCH_SKIP_PERF=1 pnpm check` green, and run `pnpm test:perf` before each push.
  - Lint with `pnpm lint`, never bare `eslint .`.
  - Server integration tests need PostgreSQL with the owner and app roles: locally the Docker container
    `wb-slice2-task3-db-1` (`postgres://wirebench:wirebench@127.0.0.1:55433/wirebench`).
- **House rules:** no local Electron or e2e windows (CI runs e2e); heavy local work under `nice`; commit as Mohammed
  Naami with no trailers; never name a product that inspired a feature; never let two implementers commit in one
  worktree at once; never bare `git stash`; worktrees under `git-worktrees/`.

## Review Focus

1. **A lost or doubled effect.** A listener that should be `local` registered as `cluster` (an audit row per
   instance), a `cluster` listener that missed an event because the bus was down with no resync, or a bus that
   delivers a process's own event twice. Tasks 3 and 4.
2. **Cross-tenant leakage through the new paths.** A payload that carries more than ids, a scope rebuilt from the
   wrong `tenantId`, a relay token that does not bind the tenant, a bucket key without the tenant, or a new table
   missing from the isolation suite. Tasks 1, 3, 8 and 12.
3. **Two writers.** A repository written by two instances (lock not held for the whole `fn`, a lock connection
   through a transaction pooler, unlock on the wrong connection), or a checkout written by two (draining that releases
   a lease before the quit path ran). Tasks 7 and 10.
4. **Self-hosted unchanged.** No new variable needed; old desktops unaffected; the push and sign-in cost measured;
   `multi` refused without Enterprise. Tasks 2, 7, 8 and 14.
5. **Metrics privacy.** No attribute outside the closed set, no slug, no URL, nothing pushed without an endpoint.
   Task 13.

---

## Part A — the instance table and the bus

### Task 1: migration `0022`

**Files:**
- Create: `packages/server/migrations/operations/0022_operations.sql`,
  `packages/server/test/integration/operations/migration.test.ts`
- Modify: `packages/server/src/serve.ts` (`allMigrations`), the tenancy migration test's allowlist,
  `test/integration/tenancy/isolation.test.ts` (fill and sweep the new scoped tables), `src/tenancy/revert.ts` if
  revert must drop them, `scripts/check-tenant-scope.ts`

**Interfaces:**
- `server_instances` exactly as spec §20.2, unscoped, granted to the app role.
- `limiter_buckets(tenant_id, key text, tokens double precision, updated_at timestamptz)`, unlogged, primary key
  `(tenant_id, key)`.
- `send_slots(tenant_id, slot smallint, holder uuid, expires_at timestamptz)`, unlogged, primary key
  `(tenant_id, slot)`.
- `terminal_share_locations(tenant_id, share_id text, holder uuid, created_at)`, primary key `(tenant_id, share_id)`.
- The three scoped tables get `tenant_id uuid not null` with the setting default, forced row-level security and the
  one `tenant_isolation` policy, as guard 3 demands (§19.8).

- [ ] Write failing tests:
  - guard 3's migration test passes with the three scoped tables and `server_instances` on the allowlist;
  - outside `withTenant`, the three scoped tables show no rows and refuse inserts;
  - the isolation suite fills and sweeps them;
  - `admin tenancy revert` on a database at `0022` either drops `0022`'s tables first or refuses with a message (pick
    one, test it).
- [ ] Implement, run `pnpm check`, commit.

### Task 2: one instance or several, and the instance heartbeat

**Files:**
- Create: `packages/server/src/operations/instances.ts`, `packages/server/src/operations/cli.ts` (`admin instances`),
  tests
- Modify: `packages/server/src/config.ts` (`WIREBENCH_SERVER_INSTANCES`, `WIREBENCH_SERVER_INSTANCE_URL`, whose port
  is the internal listener's), `packages/server/src/serve.ts`, `packages/server/src/args.ts`,
  `packages/server/src/host/module.ts` (pass the mode to `clearLeasesAtStartUp`), `packages/server/src/host/lease.ts`

**Interfaces:**
- `ServerConfig.instances: 'single' | 'multi'`; hosted configs are `multi`. `multi` without an instance URL is a
  config error.
- `InstanceRegistry` (`start`, `renew`, `live(): Promise<InstanceRow[]>`, `stop`): inserts the row, renews it with the
  host leases' timer (one timer, not two), deletes rows older than 60 s, deletes its own row on shutdown.
- `multi` self-hosted: `serve` reads the default tenant's license state and refuses with
  `server-instances-need-enterprise` unless Enterprise and valid or in grace; a lapse while running logs a warning
  hourly. The license read goes through `forEachTenant` or an allowlisted call, never a bare `defaultScope(` outside
  the admin command line (§19.8).
- `clearLeasesAtStartUp` runs in `single` only.

- [ ] Write failing tests: the row appears, renews and goes on shutdown; a dead row is swept by another instance;
  `multi` refused on Community and Team, accepted on Enterprise; a lapse warns and does not stop; `single` still
  clears leases and `multi` does not; `admin instances` lists rows and prints no tenant; `config check` reports the
  two new variables.
- [ ] Implement, regenerate the config and command docs, run `pnpm check`, commit.

### Task 3: the notification bus

**Files:**
- Create: `packages/server/src/operations/bus.ts`, `packages/server/src/operations/bus-codec.ts`, tests
- Modify: `packages/server/src/context.ts` (`ServerHooks` lists carry `cluster` and `local` listeners; `announce`
  hands the event to the bus), `packages/server/src/serve.ts`, `packages/server/src/tenancy/scope.ts` only to export
  the existing scope constructor to `src/operations/` if it is not reachable (no change to its rules)

**Interfaces:**
- One `openSession` on the running lock's URL, `LISTEN wirebench_bus_<hex(hashtext(SERVER_SCHEMA))>`.
- `announce(list, event, log)` keeps "never throws, never awaits": local delivery now, then the bus queue (10 000,
  drop oldest, counted).
- Codec: `{ v: 1, from, kind, tenantId, …ids }`, at most 7 900 bytes; too large → `{ kind: 'resync', tenantId }`. A
  decoder that rejects unknown `v` and unknown kinds, and rebuilds `TenantScope` from `tenantId`.
- `onListen` and `onLost` callbacks, reconnect with backoff 1 s → 30 s.
- Listener registration is `cluster(fn)` or `local(fn)`; a bare function is a type error.
- New events `tenantsChanged`, `tenantKeysChanged`, `presenceChanged`, `presenceReset`.

- [ ] Write failing tests (two buses on one database): an event reaches the other process's `cluster` listener and not
  its `local` one; a process ignores its own notification; an oversized event becomes `resync`; a full queue drops the
  oldest; a killed listening connection reconnects and calls `onListen` again; the payload has no name, email or
  content (a codec test over every event kind); two schemas never hear each other.
- [ ] Implement, run `pnpm check`, commit.

### Task 4: the hub, presence, the host instances and shares on the bus

**Files:**
- Modify: `packages/server/src/live/hub.ts`, `packages/server/src/live/module.ts`, `packages/server/src/host/module.ts`,
  `packages/server/src/terminal-shares/module.ts`, `packages/server/src/audit-log/module.ts` (its `licenseChanged`
  listener is `local`), tests

**Interfaces:**
- The hub, the host instances' `sessionEnded` and the share registry register `cluster` listeners.
- Presence: the hub announces `presenceChanged` with its own users per room; keeps other holders' lists; sends the
  union; drops a holder's lists on `presenceReset` from it or when its instance row dies (Task 2's `live()`).
- Resync: per room, `head` with the current head, then `access`, then `presence` (spec §20.3), on a `resync` event for
  the tenant and on the bus's `onListen` after a loss.

- [ ] Write failing tests with two hubs over two buses on one database: `headMoved` on one reaches the other's
  sockets; `accessChanged` re-checks roles there; `sessionEnded` closes sockets, host instances and share peers there;
  presence is the union and drops a stopped holder; a lost bus resyncs with the three known messages; one
  `licenseChanged` writes one audit row in a fleet of two.
- [ ] Implement, run `pnpm check`, commit.

### Task 5: the tenant map and the data-key cache

**Files:**
- Modify: `packages/server/src/tenancy/tenancy.ts`, `packages/server/src/tenancy/keys.ts` (announce
  `tenantKeysChanged` where a key is written), `packages/server/src/server.ts` (wire `resolver.invalidate()` to a
  `cluster` listener through `onTenantResolver`), tests

- [ ] Write failing tests: a tenant created through one process resolves on the other within 2 s; a data-key change
  on one is seen by the other's cache; after a bus loss both caches are invalidated; the resolver's poll is 10 min.
- [ ] Implement, run `pnpm check`, commit.

### Task 6 (Part A close): PR

- [ ] Run the whole-branch review and its fix wave, then push `feat/operations-bus` and open the PR ("Part 1 of
  #821"). Move #821 to In review, turn on Auto-fix.
- [ ] Merge with `gh pr merge --merge` once every check is green on the latest head. Move #821 back to In progress.

---

## Part B — the lock, the limiter, the budgets and draining

### Task 7: the advisory repository lock

**Files:**
- Modify: `packages/server/src/repos/repo-store.ts`, `packages/server/src/serve.ts` (the lock pool),
  `packages/server/src/sync/routes/commits.ts` and `teams/routes/workspaces.ts` only for the `503 repo-busy`
  mapping, tests

**Interfaces:**
- `withLock(scope, workspaceId, fn)` unchanged in shape; after the in-process queue it takes
  `pg_advisory_lock(REPO_LOCK_CLASS, hashtext(SERVER_SCHEMA || ':' || tenant || ':' || workspace))` on a lock-pool
  connection held for `fn`, unlocks on the same connection, and returns it.
- Lock pool on the running lock's URL, `max` 8. A wait over 30 s → `503 repo-busy`, `Retry-After: 5`. A lost
  connection → `repo-lock-lost` before the next git step.
- `drain()` waits for held database locks too.

- [ ] Write failing tests: two `RepoStore`s on one database serialise one workspace and not two; two tenants with the
  same workspace id do not block each other; a 30 s wait answers `503`; a killed lock connection ends `fn` with
  `repo-lock-lost`; the lock is never left held after `fn` throws.
- [ ] Measure a push before and after with `pnpm test:perf`, implement, run `pnpm check`, commit.

### Task 8: the shared limiter

**Files:**
- Create: `packages/server/src/operations/limiter.ts`, tests
- Modify: `identity/rate-limit.ts` (the `RateLimiter` interface stays; its store becomes the table),
  `hooks/rate-limit.ts` (`CatchBuckets`), `agent/routes.ts` (`PairingBudget`), and each module that constructs a
  limiter (`identity`, `sso`, `licensing`, `sync`, `audit-log/desktop-routes.ts`, `agent`, `hooks`), tests

**Interfaces:**
- `charge(tx, key, { capacity, refillPerMs, cost }) → { ok, tokens, retryAfterMs }` in one statement inside the
  tenant's transaction (`insert … on conflict do update … returning`).
- Keys, sizes and refill rates unchanged; every limiter's existing tests pass unchanged.

- [ ] Write failing tests: two processes share one bucket; the refill matches the old in-memory limiter's; two tenants'
  buckets with the same key are apart; every existing limiter suite passes against the table.
- [ ] Measure a sign-in before and after, implement, run `pnpm check`, commit.

### Task 9: the per-tenant budgets

**Files:**
- Create: `packages/server/src/operations/send-channels.ts`, `packages/server/src/operations/budgets.ts`, tests
- Modify: `packages/server/src/config.ts` (the three `WIREBENCH_SERVER_TENANT_*` variables),
  `packages/server/src/host/module.ts` (charge send channels on the host socket),
  `packages/server/src/schedules/scheduler.ts` (run slots in the claim),
  `apps/desktop/src/browser/browser-bootstrap.ts` only if the refusal needs a message it does not have

**Interfaces:**
- `SEND_CHANNELS`: the host's send channels; a test over the channel registry fails on an unlisted send channel.
- Per send: charge `sends` (600 per minute, burst 100), then take a `send_slots` slot (16), and free it after; slot
  expiry is the send's deadline plus 30 s. Refusals `tenant-send-budget` and `tenant-send-concurrency` with
  `retryAfterMs`.
- Scheduler: the claim skips a tenant with as many `running` runs as its slots (2), counted in the claiming
  transaction; the round-robin moves on.

- [ ] Write failing tests: the 101st burst send is refused with `retryAfterMs`; the 17th concurrent send is refused on
  either of two processes; a crashed process's slots free themselves after expiry; an agent send is not charged; a
  tenant with two running runs waits while another tenant's run starts; the registry test catches a new send channel.
- [ ] Implement, regenerate the config docs, run `pnpm check`, commit.

### Task 10: draining and `/readyz`

**Files:**
- Modify: `packages/server/src/serve.ts`, `packages/server/src/routes/health.ts`, `packages/server/src/host/errors.ts`
  (`host-draining`), `packages/server/src/host/instances.ts`, `packages/server/src/live/hub.ts` (`1012` on drain),
  `apps/desktop/src/browser/browser-bootstrap.ts` (reconnect at once after `4503 host-draining`), tests

- [ ] Write failing tests: `/readyz` is `503` before start-up finishes, while the bus reconnects and while draining;
  `SIGTERM` closes host sockets `4503 host-draining` after the quit path and releases leases at once, so a second
  process takes the user without waiting for expiry; live sockets close `1012`; the bootstrap reconnects after
  `4503` with no backoff.
- [ ] Implement, run `pnpm check`, commit.

### Task 11 (Part B close): PR

- [ ] Run the whole-branch review and its fix wave, then push `feat/operations-locks` and open the PR ("Part 2 of
  #821"). Move #821 to In review, Auto-fix on, merge when every check is green, back to In progress.

---

## Part C — the relay, the metrics, two instances and the docs

### Task 12: the share relay

**Files:**
- Create: `packages/server/src/operations/internal-server.ts` (the second listener),
  `packages/server/src/operations/relay-token.ts`, `packages/server/src/terminal-shares/relay.ts`, tests
- Modify: `packages/server/src/terminal-shares/module.ts`, `packages/server/src/terminal-shares/socket.ts`,
  `packages/server/src/serve.ts`

**Interfaces:**
- The owner's instance writes `terminal_share_locations` on start and deletes it on end.
- A viewer's instance that does not hold the share looks up the row; a row whose holder is not live is no share;
  otherwise it dials `<holder url>/internal/v1/shares/<share_id>` with a token and pipes frames unchanged.
- Token: HMAC-SHA-256 under HKDF(`WIREBENCH_SERVER_SECRETS_KEY`, "wirebench/instance-relay/v1"), binding tenant,
  share, viewer user and token ids, target holder, and an expiry 30 s ahead; compared in constant time.
- The internal listener serves only `/internal/v1/*`; the public one answers `404` there. `single` never dials.

- [ ] Write failing tests: a viewer on process B joins a share owned on A, sees the screen, requests and gets control,
  and A's registry applies its viewer limit and audit once; every wrong or expired token is refused; the public port
  answers `404` on `/internal/`; a share whose holder died is no share; the owner ending the share ends the relayed
  viewer.
- [ ] Implement, run `pnpm check`, commit.

### Task 13: metrics by tenant id

**Files:**
- Create: `packages/server/src/operations/metrics/{sdk.ts,instruments.ts,attributes.ts}`, tests
- Modify: `scripts/third-party-licenses.ts` (first), `packages/server/package.json`, `packages/server/src/server.ts`
  (request hook for the HTTP instruments), the modules that record (live, host, budgets, schedules, repo store, bus,
  pools)

**Interfaces:**
- The SDK starts only when `OTEL_EXPORTER_OTLP_METRICS_ENDPOINT` or `OTEL_EXPORTER_OTLP_ENDPOINT` is set; otherwise a
  no-op meter, and the SDK module is never imported (dynamic `import()`).
- The instruments of spec §20.8; `wirebench.tenant.id` is the uuid or `none`; the route is Fastify's template.
- `attributes.ts` holds the closed set; a test over an in-memory exporter fails on any other key, or on a value shaped
  like a URL, an email or a slug.

- [ ] Write failing tests: no endpoint → no SDK import and no export; with an in-memory reader, each instrument
  records with its attributes; the sweep finds only allowed keys; `service.instance.id` is the holder.
- [ ] Add the licences entries, install the four packages pinned exactly, implement, run `pnpm check`, commit.

### Task 14: two instances, end to end, and perf

**Files:**
- Create: `packages/server/test/integration/operations/two-instances.test.ts`, a perf case in
  `packages/server/test/perf/`
- Modify: `.github/workflows/ci.yml` only if the suite needs a step the server shard lacks (it should not)

- [ ] Write the suite of spec §20.11 against two full servers on one schema and one data directory, each with its own
  holder, internal port and bus.
- [ ] Record the one-instance push and sign-in cost before and after slice 5 in the PR.
- [ ] Run `pnpm check` and `pnpm test:perf`, commit.

### Task 15: docs

**Files:**
- Modify: `packages/server/README.md` (several instances: what they need, Enterprise for self-hosted, a private
  network for the relay, a direct connection for the bus and the lock pool),
  `docs-site/src/content/docs/guides/wirebench-server.mdx` (a "Running several instances" section with the Traefik
  sticky-cookie example and `/readyz`), `docs/adr/0009-…` and `docs/adr/0013-…` (amendment notes, spec §20.12),
  `docs/adr/0037-…` (accepted), the spec's §10 slice 5 row (built, with PR numbers), `CHANGELOG.md` (one Added
  entry), the server-config docs.
- [ ] Run `pnpm check:banned-terms` and `pnpm check`, commit.

### Task 16 (Part C close): PR

- [ ] Run the whole-branch review and its fix wave, then open the PR ("Part 3 of #821, closes #821"). Move #821 to In
  review, Auto-fix on, merge when every check is green.
- [ ] Move #821 to Done, and tick slice 5 in #776 with the three PR numbers.
