# Control plane (slice 7 of #776) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** An operator can switch hosted mode on, and a team can sign up, pay through Paddle, sign in, be suspended,
export, import and be deleted without an operator, with its own identity provider, forwarding, mail and retention
settings, edited from a settings screen.

**Architecture:** Eight parts, one pull request each, in dependency order. Parts A–F and G's server half touch nothing
of slice 5's except reading what is merged; G's budget overrides wait for slice 5's budgets task.

- **Part A** (Tasks 1–4): the control role, migration `0023`, the `control-plane` module skeleton, the gates.
- **Part B** (Tasks 5–8): edition from the tenant row, the lifecycle writes, rename and retired slugs, the operator
  commands.
- **Part C** (Tasks 9–11): suspension in the resolver, the routes, the sockets and the jobs.
- **Part D** (Tasks 12–15): the Paddle verifier and adapter, the webhook, applying events, the grace sweep and mails.
- **Part E** (Tasks 16–18): signup pages, the checkout step, completion and first sign-in.
- **Part F** (Tasks 19–24): the tar writer, export, offline verify, import, deletion, the tenant routes.
- **Part G** (Tasks 25–31): per-tenant settings, each module on them, the API, then the settings screen.
- **Part H** (Tasks 32–34): hosted mode accepted, the recipe end to end, the docs and wrap-up.

**Tech Stack:** TypeScript (ESM), Fastify 5, `pg`, `nodemailer` (existing), `node:crypto` (HMAC, AES-GCM), `node:zlib`,
git (`bundle`), React (the renderer), vitest, Playwright (browser e2e, CI only).

**Spec:** `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.6, §4.3, §5.6, §8, §19, §20, §21 and §22 (which
wins where they differ); ADR-0039; issue #829.

## Global Constraints

- **No real keys, no real domain.** Paddle values in tests and docs are `test_…`, `pri_test…` and `pdl_ntfset_test…`
  placeholders; names are `app.test`, `site.test`, `<app-domain>`. No secret in a log line, an error or test output.
- **Hosted mode stays refused** by `loadConfig` until Task 32. Tests build a hosted `ServerConfig` directly.
- **Self-hosted unchanged.** No new page, route or output, except the read-only settings screen and `admin tenant
  export|import`, which are new for every server.
- **Slice 5.** Never edit `src/operations/`. Merge `main` into the branch as slice 5's parts merge. Budget overrides
  (Task 28) build on its merged budget code. Migration `0023` is claimed for this slice (checked with slice 5).
- **Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` green before each task's commit; `pnpm test:perf` before each push; one
  commit per task as Mohammed Naami <m.naami@outlook.com>, no trailers. `pnpm lint`, never bare `eslint .`. No local
  Electron or e2e windows; heavy commands under `nice`. `pnpm check:banned-terms` before each push.

## Review Focus

1. **The bypass leaking.** `ControlDb` or its URL reachable outside `src/control-plane/`; a route running on it; a
   per-tenant write on it. Tasks 1, 3, 13, 23.
2. **Billing correctness.** Signature before parse, constant-time compare, replay, order, an `operator` edition
   overwritten, a subscription moved between tenants. Tasks 12–14.
3. **Suspension holes.** Any route, socket, job or share that still serves a suspended tenant; a server admin of a
   suspended tenant signing in. Tasks 9–11.
4. **Export contents.** A sealed value, a session or a checkout secret in an export; an unclassified scoped table.
   Tasks 19–20.
5. **Deletion completeness and safety.** A row, file or key left; a deletion while billed; a crash mid-way. Task 23.
6. **Settings secrets.** A sealed field read back by any API or log; a tenant reaching another's provider; a tenant
   raising its own budget. Tasks 25–29.

---

## Part A — the control role, the tables, the module

### Task 1: the control role and its URL

**Files:**
- Modify: `packages/server/src/config.ts` (`WIREBENCH_SERVER_CONTROL_DATABASE_URL`, secret, hosted-only, out of
  `ModuleConfig`; `forgetDatabaseUrls` forgets it), `packages/server/src/tenancy/roles.ts` and `grants.ts` (create
  `wirebench_control` in hosted mode, its grants, `--print-sql`, `tenancy-control-role-create-refused`),
  `packages/server/src/tenancy/checks.ts` (`checkControlRole`: bypass, not superuser, owns nothing, differs),
  `packages/server/src/serve.ts` (open the control pool, max 2, hosted only).
- Create: `packages/server/src/control-plane/control-db.ts` (`ControlDb` brand).
- Test: `test/unit/config-control.test.ts`, `test/integration/tenancy/control-role.test.ts` (attributes, grants, each
  refusal, the app role still isolates); `test/helpers` gains a control-role URL for hosted tests.

- [ ] Failing tests, implement, gate, commit.

### Task 2: migration 0023

**Files:**
- Create: `packages/server/migrations/control-plane/0023_control-plane.sql` (§22.3, `tenant_scope()` on the three
  scoped tables in the same file).
- Modify: `test/helpers/catalog.ts` (`UNSCOPED_TABLES` + 4, `SCOPED_TABLES` + 3), the migration test's expectations,
  the isolation suite's tables.
- Test: the migration test passes; a two-tenant case on each scoped table.

- [ ] Failing tests, implement, gate, commit.

### Task 3: the module and the gates

**Files:**
- Create: `packages/server/src/control-plane/module.ts` (`name: 'control-plane'`, `migrationsDir`, registers nothing
  outside hosted mode; receives `ControlDb` through a context field set only by `serve.ts`).
- Modify: `packages/server/src/context.ts` (module name union, the optional control field), `packages/server/src/modules.ts`,
  the three module-name list tests, `scripts/check-tenant-scope.ts` (control URL, `ControlDb`, the control tables and
  `from tenants` only in `src/control-plane/`) and its tests.
- Test: the module serves nothing in self-hosted mode; the script refuses each pattern outside the directory.

- [ ] Failing tests, implement, gate, commit.

### Task 4 (Part A close): PR

- [ ] Whole-part review (Review Focus 1) and its fix wave; push `feat/control-plane-role`; open the PR ("Part 1 of
  #829"); Auto-fix on; merge with `gh pr merge --merge` once every check is green on the latest head.

---

## Part B — lifecycle and operator commands

### Task 5: edition from the tenant row

**Files:**
- Modify: `packages/server/src/licensing/service.ts` (hosted `state(scope)` from `tenants.edition` and `seats`),
  `licensing/routes.ts` and `licensing/cli.ts` (`409 licensing-hosted`), `tenancy/directory.ts` (`TenantRow` gains the
  new columns).
- Test: hosted state per edition and seats; the seat lock and the host cap read them; license upload refused;
  self-hosted unchanged.

- [ ] Failing tests, implement, gate, commit.

### Task 6: the lifecycle service

**Files:**
- Create: `control-plane/tenants.ts` (`create`, `setEdition`, `suspend`, `resume`, `requestDeletion`,
  `cancelDeletion`: each a control transaction that announces `tenantsChanged` and writes `tenant.<verb>` in the
  tenant's chain), `control-plane/slugs.ts` (the slug lock and the three-table check).
- Modify: `tenancy/directory.ts` (`TenantAdmin.create` takes `editionSource`, `status` and `suspendedReason`).
- Test: each verb; two concurrent creates of one slug, one wins; a retired or pending slug refused.

- [ ] Failing tests, implement, gate, commit.

### Task 7: rename and retired redirects

**Files:**
- Modify: `control-plane/tenants.ts` (`rename`), `tenancy/resolve.ts` (`308` for a live redirect, `404` after),
  `tenancy/directory.ts` (redirects loaded into the map).
- Test: the old host redirects with path and query; an expired redirect `404`s; the slug is never reusable.

- [ ] Failing tests, implement, gate, commit.

### Task 8: `admin tenant` commands, and the Part B PR

**Files:**
- Modify: `packages/server/src/args.ts`, `main.ts`; create `control-plane/cli.ts` (`list`, `create`, `set-edition`,
  `suspend`, `resume`, `rename`, `delete [--cancel]`; `export`, `import` and `settings` arrive with their tasks); the
  command docs through `pnpm docs:commands`.
- Test: each command against a hosted test server; the self-hosted refusals; `create` mails or prints the invitation.

- [ ] Failing tests, implement, gate, commit.
- [ ] Review (Focus 1), fixes, push `feat/control-plane-lifecycle`, PR ("Part 2 of #829"), Auto-fix on, merge when
  green.

---

## Part C — suspension

### Task 9: the resolver and the routes

**Files:**
- Modify: `tenancy/directory.ts` (the hosted map holds active and suspended tenants with status and reason),
  `tenancy/resolve.ts` (suspended: the sign-in page, `503` on `/hooks/`, `403 tenant-suspended` elsewhere, before any
  module route), `identity/sign-in-page.ts` (one paragraph per reason, no form).
- Test: each reason; a sweep of every route in the route map answers a suspended tenant correctly; `deleting` still
  `404`s.

- [ ] Failing tests, implement, gate, commit.

### Task 10: sockets, hosts and shares

**Files:**
- Modify: `live/module.ts`, the host instance registry in `host/`, `terminal-shares/`: each listens to
  `tenantsChanged` and closes a suspended tenant's sockets (`4403 tenant-suspended`), disposes its hosts, releases the
  leases and ends its shares. No edit in `src/operations/`.
- Test: suspending on one instance closes sockets on another through the bus.

- [ ] Failing tests, implement, gate, commit.

### Task 11: jobs, and the Part C PR

**Files:**
- Modify: `schedules/scheduler.ts` (skip suspended; the next run computed from the resume), `schedules/alerts/outbox.ts`
  (hold).
- Test: no fire while suspended; resume computes from now; retention still runs.

- [ ] Failing tests, implement, gate, commit.
- [ ] Review (Focus 3), fixes, push `feat/control-plane-suspension`, PR ("Part 3 of #829"), merge when green.

---

## Part D — billing

### Task 12: the verifier and the adapter

**Files:**
- Create: `control-plane/billing/signature.ts` (parse `ts` and every `h1`, HMAC-SHA256, constant time, 300 s window),
  `control-plane/billing/paddle.ts` (event → `SubscriptionEvent`), `control-plane/billing/events.ts` (the vocabulary),
  `test/fixtures/paddle/*.json` (one per `subscription.*` type, synthetic ids).
- Modify: `config.ts` (the four Paddle variables: hosted-only, required in hosted, `_FILE` for the secret, the token's
  prefix matching the environment).
- Test: Paddle's documented example; two `h1`; a stale `ts`; one byte changed; each fixture mapped; no Team item
  refused.

- [ ] Failing tests, implement, gate, commit.

### Task 13: the webhook and applying events

**Files:**
- Create: `control-plane/billing/webhook.ts` (`POST /billing/paddle`, `ENTRY_ROUTE`, raw body ≤ 1 MiB),
  `control-plane/billing/apply.ts` (one control transaction: `billing_events` first, order by `last_event_at`, the
  table of §22.5).
- Modify: the route map (`entry`).
- Test: a replay is a no-op `200`; an older event is recorded, not applied; an `operator` edition is untouched; a ref
  held by another tenant is refused; `deleted` suspends `canceled`; `active` resumes; `500` on a database failure.

- [ ] Failing tests, implement, gate, commit.

### Task 14: the grace sweep and mails

**Files:**
- Create: `control-plane/loop.ts` (§22.15, the advisory-locked pass), `control-plane/mail.ts` (past due, three days
  left, suspended; plain text; the operator's SMTP through `sendAlertMail`).
- Test: with an injected clock, day 14 suspends `unpaid`; a payment before it resumes; each mail goes once; a failing
  step does not stop the others.

- [ ] Failing tests, implement, gate, commit.

### Task 15 (Part D close): PR

- [ ] Review (Focus 2), fixes, push `feat/control-plane-billing`, PR ("Part 4 of #829"), merge when green.

---

## Part E — signup

### Task 16: the signup form and the mail

**Files:**
- Create: `control-plane/signup/routes.ts` (`GET` and `POST /signup`, `ENTRY_ROUTE`), `signup/page.ts`,
  `signup/repo.ts`.
- Test: `Origin`, size, rate limits; a taken, reserved or retired slug re-renders; the same answer for an address
  with or without teams; the mail's link holds the token once.

- [ ] Failing tests, implement, gate, commit.

### Task 17: verify, password, checkout

**Files:**
- Modify: `signup/routes.ts` (`GET` and `POST /signup/:token`, `GET /signup/:token/status`), `signup/page.ts` (the
  checkout step, Paddle.js, the CSP for that page only).
- Test: an expired or used token; the password minimum; the CSP names only Paddle's origins; status `pending`.

- [ ] Failing tests, implement, gate, commit.

### Task 18: completion and first sign-in, and the Part E PR

**Files:**
- Modify: `billing/apply.ts` (`created` with `signup` → tenant, admin, subscription), `signup/repo.ts`.
- Test: end to end with a fake checkout posting a signed fixture: the tenant resolves, the status is `ready`, sign-in
  with the chosen password succeeds; a webhook after the token's expiry still completes; a duplicate webhook makes
  one tenant.

- [ ] Failing tests, implement, gate, commit.
- [ ] Review, fixes, push `feat/control-plane-signup`, PR ("Part 5 of #829"), merge when green.

---

## Part F — export, import, deletion

### Task 19: the tar writer and the classification

**Files:**
- Create: `control-plane/export/tar.ts` (ustar write and read, gzip), `control-plane/export/tables.ts` (every scoped
  table classified).
- Modify: `packages/core/src/sync/git-cli.ts` (`bundle` for the server).
- Test: a tar round trip with long names; the classification test fails on an unclassified scoped table (catalog
  query).

- [ ] Failing tests, implement, gate, commit.

### Task 20: export

**Files:**
- Create: `control-plane/export/export.ts` (the snapshot read, NDJSON, the redactions, the bundles under the repo lock,
  the manifest and its chain block), `control-plane/export/runner.ts` (queued in the loop, one per tenant, at most
  three kept, expiry).
- Test: no sealed value, session or checkout file; the checksums match; one running per tenant.

- [ ] Failing tests, implement, gate, commit.

### Task 21: offline verify

**Files:**
- Modify: `audit-log/cli.ts` (`admin audit verify --export <file>`), `audit-log/chain/verify.ts` (verify from lines and
  a key, no database).
- Test: a fresh export verifies; one edited byte in `audit_events.ndjson` fails, naming the event.

- [ ] Failing tests, implement, gate, commit.

### Task 22: import

**Files:**
- Create: `control-plane/export/import.ts` (the checks, foreign-key order from the catalog, the units, the bundles
  fetched, the re-key, the `tenant.imported` event, the report).
- Modify: `control-plane/cli.ts` (`export`, `import`).
- Test: a self-hosted export imports into hosted, exports again and imports into an empty self-hosted server, and every
  workspace syncs; a non-empty target is refused; a broken chain is refused; a crash mid-tables resumes.

- [ ] Failing tests, implement, gate, commit.

### Task 23: deletion

**Files:**
- Create: `control-plane/delete.ts` (the five steps of §22.11, idempotent; waits while billed).
- Test: rows and directory gone, checked on the control role; the slug retired; `tenant_deletions` holds the anchor; a
  crash after each step resumes; an active subscription makes it wait.

- [ ] Failing tests, implement, gate, commit.

### Task 24: tenant routes, and the Part F PR

**Files:**
- Create: `control-plane/tenant-routes.ts` (`GET /api/v1/tenant/billing`, the exports' list, request and file, the
  deletion's request and cancel; server admins only; on tenant hosts; the export routes in self-hosted mode too).
- Modify: the route map (`own`), two-tenant cases.

- [ ] Failing tests, implement, gate, commit.
- [ ] Review (Focus 4 and 5), fixes, push `feat/control-plane-export`, PR ("Part 6 of #829"), merge when green.

---

## Part G — per-tenant settings and the screen

### Task 25: the settings store

**Files:**
- Create: `packages/server/src/settings/` (`sections.ts` with the zod schemas, `store.ts` sealed under the data key,
  `service.ts` with `of(scope, section)` and the bus invalidation `tenantSettingsChanged`, environment-backed in
  self-hosted mode).
- Test: a secret is never read back; self-hosted answers `environment`; two tenants apart; the cache invalidated
  across instances.

- [ ] Failing tests, implement, gate, commit.

### Task 26: identity and SSO per tenant

**Files:**
- Modify: `identity/env.ts`, `identity/oidc.ts`, `identity/module.ts` (an OIDC client per tenant), `sso/env.ts`,
  `sso/module.ts` (SAML per tenant from the stored XML; the SAML and SCIM routes in hosted mode), `config.ts` (hosted
  refuses the environment variables with `control-plane-setting-per-tenant`).
- Test: the OIDC, SAML and SCIM two-tenant cases through the routes; no settings answers as disabled.

- [ ] Failing tests, implement, gate, commit.

### Task 27: forwarding, mail, retention per tenant

**Files:**
- Modify: `audit-log/forward/*` (a sink per tenant, per-tenant backoff, a failure stops only that tenant),
  `schedules/alerts/outbox.ts` (the tenant's SMTP, else the operator's), each retention sweep (the tenant's ages within
  the maxima).
- Test: one tenant's dead sink does not stop the other's; ages clamp to the operator's maxima.

- [ ] Failing tests, implement, gate, commit.

### Task 28: budget overrides (after slice 5's budgets merge)

**Files:**
- Modify: slice 5's budget reader through its public function only (no edit in `src/operations/` unless that session
  agrees), `settings/sections.ts` (`budgets`, operator only).
- Test: an override applies; a tenant's `PUT` is refused with `settings-operator-only`.

- [ ] Failing tests, implement, gate, commit.

### Task 29: the settings API and CLI

**Files:**
- Create: `settings/routes.ts` (`GET`, `PUT` and `DELETE /api/v1/tenant/settings…`); `control-plane/cli.ts` gains
  `settings`.
- Test: validation per section (issuer discovery against a fake, metadata parse, URL rules); `settings.changed` holds
  no value; the route map's `own`.

- [ ] Failing tests, implement, gate, commit.

### Task 30: the channels and the host

**Files:**
- Modify: `packages/wire` (channel contracts `serverSettings.*`, `tenantBilling.get`, `tenantExports.*`,
  `tenantDeletion.*`), `packages/host` (handlers calling the server API), the server host's allowlist (§3.10), the
  agent's browser-subset test (not served there).
- Test: the allowlist and subset tests; the handlers against a fake server.

- [ ] Failing tests, implement, gate, commit.

### Task 31: the screen, and the Part G PR

**Files:**
- Create: `apps/desktop/src/renderer/features/preferences/server/` (one component per section, the page), its state
  slice.
- Modify: `settings-page.tsx` (the *Server* entry for server admins).

- [ ] Publish a mockup artifact of the page and ask the owner to approve it (popup) before building.
- [ ] Component tests per section; one browser e2e (CI) saving OIDC against a fake issuer.
- [ ] Review (Focus 6), fixes, push `feat/control-plane-settings`, PR ("Part 7 of #829"), merge when green. If the part
  is too large for one review, the server half (Tasks 25–29) and the screen (30–31) go as two PRs.

---

## Part H — hosted mode on

### Task 32: lift the refusal

**Files:**
- Modify: `config.ts` (accept `hosted`; the required and refused lists of §22.1; the variable table's description),
  `entry/module.ts` (the SMTP check moved into the config), the generated config docs (`pnpm docs:server-config`).
- Test: a hosted environment with everything set loads; each missing variable is named; each refused one is named.

- [ ] Failing tests, implement, gate, commit.

### Task 33: the recipe end to end

**Files:**
- Modify: `packages/server/deploy/hosted/{compose.yaml,env.example,README.md}` (the control role, the Paddle
  variables, the roles step); create `docs/manual-tests/2026-11-04-paddle-sandbox.md` (the first sandbox run, once an
  account exists).
- Test: the recipe parse test gains the new variables; a CI job boots the hosted compose against fixtures and runs
  signup → sign-in → suspend → export → delete.

- [ ] Failing tests, implement, gate, commit.

### Task 34: docs and wrap-up

- [ ] `packages/server/README.md` (a hosted section), the docs-site server guide, `CHANGELOG.md`, spec §10 row 7
  marked built.
- [ ] Push `feat/control-plane-hosted`, PR ("Part 8 of #829, closes #829"), merge when green.
- [ ] Tick #776's box 7 with the PR numbers; check that #829 is closed and Done on the board.
