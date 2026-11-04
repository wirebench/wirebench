# Custom domains (slice 8 of #776) Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Goal:** An Enterprise tenant claims one name of its own and proves it with a CNAME to `custom.<app-domain>` and a
TXT token. Traefik then issues the name an HTTP-01 certificate, and the tenant is served on it as its primary name,
next to `<slug>.<app-domain>`. No real domain, DNS or ACME is used anywhere.

**Architecture:** Four parts, one pull request each, in dependency order. Parts A and C need nothing from slice 7.
Part B's feature gate and Part A's mail use slice 7's per-tenant state and SMTP sender once those merge. Until then
they use what main has, and the merge that brings slice 7 in swaps them.

- **Part A** (Tasks 1–5): the name, the table, the DNS check, the state machine and the job.
- **Part B** (Tasks 6–8): serving on two names (resolver, `tenantUrl`/`primaryUrl`), the routes, the admin command.
- **Part C** (Tasks 9–11): the proxy listener for Traefik's HTTP provider, the certificate probe, the recipe with its
  Pebble test.
- **Part D** (Tasks 12–14): the wire channels and host client, the Settings tab, e2e, docs and the changelog.

**Tech Stack:** TypeScript (ESM), Fastify 5, `pg`, `node:dns/promises` `Resolver`, `node:tls`, `nodemailer` (already a
dependency), Traefik v3 (file + HTTP providers, ACME HTTP-01), Pebble and `pebble-challtestsrv` in Docker for one
test, vitest, React for the tab, Playwright for e2e.

**Spec:** `docs/specs/2026-10-24-wirebench-hosted-edition-design.md` §3.7, §19.5, §19.12, §21 and §23 (which wins);
ADR-0040; issue #830.

## Global Constraints

- **No real domain, DNS or ACME.** Tests use `app.test`, `site.test`, `example-app.test` and `customer.test`, with
  the test-only `.test` allowance. DNS goes through a fake `DnsLookup`. Certificates come from a local test CA or from
  Pebble in Docker. The Docker test skips cleanly without Docker.
- **Hosted only.** In self-hosted mode the routes answer `404`, the tab is hidden, no job runs, and no listener opens.
- **Isolation.** `custom_domains` is a tenant table (RLS forced). `tenant_hosts` is named only in
  `src/custom-domains/` and `src/tenancy/directory.ts`, which `check:tenant-scope` enforces.
- **Shared files** get small, local edits: `tenancy/resolve.ts`, `tenancy/urls.ts`, `tenancy/slugs.ts`,
  `tenancy/directory.ts`, `modules.ts`, `config.ts`, `args.ts`, `main.ts`, the recipe, `CHANGELOG.md` and the spec
  header line. One migration, numbered at merge time: the next free version on main (`allMigrations` refuses gaps; 0023 if it
  lands before slices 5 and 7 add theirs). Merge main before each Part, and again whenever slice 5 or 7
  merges.
- **Gates.** `WIREBENCH_SKIP_PERF=1 pnpm check` green before each task's commit. One commit per task, as Mohammed
  Naami <m.naami@outlook.com>, with no trailers. `pnpm test:perf` before each push. Heavy commands under `nice`. No
  local Electron or e2e windows: e2e runs in CI or in Docker. Test Postgres runs in Docker.

## Review Focus

1. **Holding a name without proof.** Any path that writes `tenant_hosts`, or switches the primary, without a fresh
   pass; a lapsed name served again; a pending claim that blocks another tenant. Tasks 4 and 5.
2. **Cross-tenant leaks.** Tokens, states or results visible to another tenant; a route or message that says who holds
   a name; `tenant_hosts` read outside its two files. Tasks 2, 4, 7.
3. **URL choice.** A browser-facing check reading `primaryUrl`, or a mailed or IdP-facing URL reading the request's
   host. Task 6.
4. **The proxy endpoint.** Reachable on the public listener, served without the token, or a host name turned into a
   Traefik identifier. Task 9.

---

## Part A — the name, the table, the check

### Task 1: the feature, the reserved slug, the name rules

**Files:**
- Modify: `packages/core/src/server-api/licensing.ts` (`'custom-domains'` in `FEATURES`), `packages/server/src/tenancy/slugs.ts`
  (`custom` in the infrastructure names), the licensing docs that list features.
- Create: `packages/server/src/custom-domains/names.ts` (`checkCustomName(name, { appDomain, siteDomain, allowTest })`,
  `recordsFor(name, token, appDomain)`, `CUSTOM_TARGET_LABEL = 'custom'`).
- Test: `packages/server/test/unit/custom-domains/names.test.ts`, the existing slugs test.

- [ ] Failing tests: every reason of §23.1 (shape, `*` label, ours, under ours, local suffixes, `.test` only with the
  allowance); `recordsFor` gives the two records exactly; `custom` reserved; an Enterprise license without a feature
  list grants `custom-domains`, and one with an explicit list that leaves it out does not.
- [ ] Implement. Check, commit.

### Task 2: the migration

**Files:**
- Create: `packages/server/migrations/custom-domains/00NN_custom-domains.sql` (next free number),
  `packages/server/src/custom-domains/migrations.ts`.
- Modify: `serve.ts` (`allMigrations` loads the folder with the tenancy migrations, as it does slice 5's), `scripts/check-tenant-scope.ts`
  and its test (`tenant_hosts` only in `src/custom-domains/` and `src/tenancy/directory.ts`), the migration and role
  tests (`test/integration/tenancy/migration.test.ts`, `role.test.ts`: `tenant_hosts` in the global allowlist with
  its reason and grants), the upgrade checks that expect the latest migration (`upgrade-compose.test.ts`, any `0022`
  or `0024` expectation), and the revert test if it lists tables.
- Test: `packages/server/test/integration/custom-domains/migration.test.ts`.

- [ ] `custom_domains` per §23.3 with `tenant_id` defaulting from the tenant setting, forced RLS and the standard
  policy, primary key `(tenant_id)`, a check on `state`. `tenant_hosts(host text primary key, tenant_id uuid not null
  references tenants on delete cascade, live boolean not null default false, since timestamptz not null default now())`,
  plus a check on the host's shape.
- [ ] Failing tests: B's transaction sees none of A's rows; a second row for one tenant is refused; deleting a tenant
  cascades `tenant_hosts`; the app role has the grants it needs and no more.
- [ ] Implement. Check, commit.

### Task 3: the DNS check

**Files:**
- Create: `packages/server/src/custom-domains/dns.ts` (`interface DnsLookup { cname, a, aaaa, txt }`,
  `systemLookup(servers?)` over `Resolver` with a 5 s timeout and two tries, `verifyRecords(lookup, name, token,
  appDomain) → { cname, txt, message }`).
- Modify: `config.ts` (`WIREBENCH_SERVER_DNS_SERVERS`, comma-separated `host[:port]`, shape-checked, hosted only) and
  the config table in `packages/server/README.md` (`pnpm docs:server-config`).
- Test: `packages/server/test/unit/custom-domains/dns.test.ts`, `config-domains.test.ts`.

- [ ] Failing tests against a fake: CNAME match with case and trailing dot; a wrong CNAME; a flattened name whose A and
  AAAA equal the target's (and one that differs, and an empty one); TXT among other strings; a TXT split into chunks
  (joined, as `resolveTxt` returns arrays); a wrong token; `ENOTFOUND`/`ENODATA` as `missing`; a timeout as a message,
  never a throw.
- [ ] Implement. Check, commit.

### Task 4: the repository and the state machine

**Files:**
- Create: `packages/server/src/custom-domains/states.ts` (a pure `next(state, result, now, since)` per §23.2's table:
  7 days pending → `expired`, 72 h failing → `lapsed`, feature gone → `paused`, every return through `verified`),
  `packages/server/src/custom-domains/repo.ts` (`get`, `claim`, `remove`, `record(result)`, `hold(name)` and
  `release(name)` on `tenant_hosts`, `setLive`, and `listAll` for the operator command, which runs over
  `forEachTenant`).
- Test: `packages/server/test/unit/custom-domains/states.test.ts`, `packages/server/test/integration/custom-domains/repo.test.ts`.

- [ ] Failing tests: every transition; `hold` is `insert … on conflict do nothing` and reports `held-elsewhere`; two
  tenants verifying the same name at once (two connections) hold it exactly once; `release` removes only the tenant's
  own row; `remove` releases first; a claim refuses a second name (`custom-domains-one-per-tenant`).
- [ ] Implement. Check, commit.

### Task 5: the check job

**Files:**
- Create: `packages/server/src/custom-domains/job.ts` (one pass per tenant unit: due claims by state and interval,
  `verifyRecords`, `next`, hold/release, audit events, mail), `packages/server/src/custom-domains/mail.ts` (plain-text
  `active`/`failing`/`lapsed` messages to the tenant's server admins through the SMTP transport the alerts use, or
  the tenant's sender once slice 7 has one).
- Test: `packages/server/test/integration/custom-domains/job.test.ts`.

- [ ] Failing tests with a fake lookup and clock: hourly for pending, 6-hourly for held; pending → verified holds the
  name; failing for 72 h releases it; feature gone → `paused` and released; a pass from `lapsed` goes through
  `verified`; audit events in the tenant's chain with no token; mail to admins only, none without SMTP; one tenant's
  failure does not stop the next.
- [ ] Implement (the job is registered with the module in Task 7). Check, commit. Open Part A's PR.

## Part B — two names, routes, command

### Task 6: resolution and the two URLs

**Files:**
- Modify: `packages/server/src/tenancy/directory.ts` (`resolvable()` returns each scope's live custom host;
  `TenantScope` gains `customHost?`), `tenancy/resolve.ts` (map both keys to the scope; for a request, remember which
  host it came on), `tenancy/urls.ts` (`tenantUrl(config, request)` = the request's host; `primaryUrl(config, scope)`;
  `tenantUrl(config, scope)` = `primaryUrl`), and the callers that must read the primary:
  - the OIDC redirect URI: `identity/routes/auth-oidc.ts`, `identity/browser-flows.ts`;
  - the SAML entity ID, ACS and metadata: `sso/routes/auth-saml.ts`, `sso/saml-metadata.ts`, `sso/module.ts`;
  - the SCIM base, and the invitation, alert and catch-URL links: `identity/routes/invitations.ts`,
    `teams/routes/invitations.ts`, `schedules/settings.ts`, `hooks/routes/manage.ts`.

  Browser-facing callers keep the request: `identity/guard.ts`, `host/browser-client.ts`, `host/module.ts`,
  `agent/routes.ts`, `live/module.ts`, `routes/meta.ts`.
- Test: `packages/server/test/integration/tenancy/resolve.test.ts`, `packages/server/test/unit/tenancy/urls.test.ts`,
  a new `test/integration/custom-domains/two-names.test.ts`.

- [ ] Failing tests: a live custom name resolves to its tenant and a verified one does not; `tenantUrl` per host;
  `primaryUrl` switches on `live` and back on release; an invitation made on the slug host links the custom name; an
  OIDC sign-in started on the slug host gets a redirect URI on the custom name; the `Origin` check on the custom host
  accepts its own origin and refuses the slug's; self-hosted unchanged.
- [ ] Implement. Audit every `tenantUrl(` caller and note its choice in the PR. Check, commit.

### Task 7: the routes and the module

**Files:**
- Create: `packages/server/src/custom-domains/module.ts` (hosted only; registers the routes and the job with the job
  loop), `packages/server/src/custom-domains/routes.ts`.
- Create: `packages/core/src/server-api/custom-domains.ts` (`customDomainSchema`: name, state, records, last result,
  checked at; the request schemas), and export it.
- Modify: `modules.ts`, the isolation suite's route map (`test/integration/tenancy/route-map.ts`).
- Test: `packages/server/test/integration/custom-domains/routes.test.ts`.

- [ ] Failing tests: §23.6's four routes; server-admin only; `requireFeature('custom-domains')` (a fake feature state
  until slice 7's per-tenant state is on main); `404 custom-domains-hosted-only` in self-hosted mode; Check now at
  most once a minute; `held-elsewhere` never names the holder; two-tenant isolation through the routes.
- [ ] Implement. Check, commit.

### Task 8: the admin command

**Files:**
- Modify: `args.ts` (`admin-domains-list`, `admin-domains-check --tenant`, `admin-domains-remove --tenant`), `main.ts`
  or the module's `cli.ts`, and the `pnpm docs:commands` output.
- Test: `packages/server/test/unit/args.test.ts`, `packages/server/test/integration/custom-domains/cli.test.ts`.

- [ ] Failing tests: parsing; `list` across tenants prints slug, name, state and checked at, never a token; `remove`
  releases; hosted only.
- [ ] Implement. Check, commit. Open Part B's PR.

## Part C — certificates

### Task 9: the proxy listener

**Files:**
- Create: `packages/server/src/custom-domains/proxy.ts`: a second Fastify instance on `WIREBENCH_SERVER_PROXY_LISTEN`
  with only `GET /proxy/traefik` and `/healthz`, a constant-time bearer check against
  `WIREBENCH_SERVER_PROXY_TOKEN_FILE`, and the payload of §23.4 with router names
  `custom-<first 16 hex of sha256(host)>`.
- Modify: `config.ts` (the two variables; the token file required when the listener is set; hosted only), `serve.ts`
  (start and close it beside the main listener), the README config table.
- Test: `packages/server/test/unit/custom-domains/proxy.test.ts`, `test/integration/custom-domains/proxy.test.ts`.

- [ ] Failing tests: `401` without a token or with a wrong one; the payload for verified, active and failing names
  only; the route absent on the public listener; no listener when unset; the token never logged.
- [ ] Implement. Check, commit.

### Task 10: the certificate probe

**Files:**
- Create: `packages/server/src/custom-domains/probe.ts` (`tls.connect` to `WIREBENCH_SERVER_PROXY_TLS_ADDRESS` with SNI,
  `checkServerIdentity`, roots or `WIREBENCH_SERVER_PROXY_TLS_CA_FILE`, 5 s timeout).
- Modify: `job.ts` (verified → active through the probe; `setLive`), `config.ts`.
- Test: `packages/server/test/unit/custom-domains/probe.test.ts` (a local TLS server with a test CA made in the test).

- [ ] Failing tests: a certificate for the name passes; another name's, a self-signed one or an expired one fails; a
  closed port fails within the timeout; the job activates on a pass and mails.
- [ ] Implement. Check, commit.

### Task 11: the recipe

**Files:**
- Modify: `packages/server/deploy/hosted/compose.yaml` (the HTTP provider's endpoint, poll interval and header from the
  secret; the `le-http` resolver with `httpChallenge.entryPoint=web`; the server's `PROXY_*` variables and the shared
  token secret), `env.example`, `README.md` (the custom-domain runbook: what a customer creates, what an operator
  sees, how to remove a name for abuse).
- Modify: `packages/server/test/unit/deploy-hosted.test.ts` (the parse test).
- Create:
  - `packages/server/test/integration/custom-domains/pebble.test.ts` (built there, beside the other Docker-gated
    integration tests, so no new vitest project is needed): skips without Docker. Runs Traefik, Pebble,
    `pebble-challtestsrv` as Traefik's resolver and a stub server answering `/proxy/traefik`, then asserts issuance
    and that the probe sees the name.
  - `docs/manual-tests/2026-11-04-custom-domain.md`: against Let's Encrypt staging, once a domain exists.

- [ ] Failing parse-test cases: the provider endpoint and header, `le-http` with the `web` entry point, the server not
  publishing `8081`, the token as a file secret.
- [ ] Implement. Run the Pebble test locally under `nice`. Check, commit. Open Part C's PR.

## Part D — the app

### Task 12: channels and the host client

**Files:**
- Modify: `packages/wire/src/ipc.ts` and `wire-base.ts` (`server.domain.get|claim|check|remove`),
  `packages/host/src/server-client.ts` (four calls), `packages/host/src/ipc/` (a `domain.ts` handler beside
  `provisioning.ts`), the browser host's channel list (§3.10 allowlist) and the vitest API mock.
- Test: the host's IPC tests and the server-client tests.

- [ ] Failing tests, then implement. Check, commit.

### Task 13: the Domain tab

**Files:**
- Create: `apps/desktop/src/renderer/state/domain.ts`, `apps/desktop/src/renderer/features/team/domain-tab.tsx`.
- Modify: `apps/desktop/src/renderer/features/team/team-dialog.tsx` (an admin tab for server admins of a hosted server
  whose license grants `custom-domains`), the `TeamTab` type in the team state.
- Test: `apps/desktop/src/renderer/features/team/domain-tab.test.tsx`.

- [ ] Failing tests: each state's words and actions; copy buttons for both records; the identity-provider notice when
  active; Remove behind a confirm; hidden in self-hosted and without the feature.
- [ ] Implement with the existing components (`Button`, `ConfirmDialog`, the Provisioning tab's layout). Check,
  commit.

### Task 14: e2e, docs, changelog

**Files:**
- Create: `apps/desktop/e2e/team-domain.spec.ts` (against the Docker server rig, hosted config, fake DNS through the
  test-only lookup hook), and a Custom domain section in `docs-site/src/content/docs/guides/wirebench-server.mdx`.
- Modify: `CHANGELOG.md` (`[Unreleased]`), the spec's §10 row 8 (built), #776's box 8.
- [ ] e2e green in CI. Check, commit. Open Part D's PR.
