# Harden desktop activity reporting — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Close the eight low-severity edge cases in desktop activity reporting that the #211 review found (issue #213), so the trail is more complete and the desktop is politer to the server.

**Architecture:** Mostly desktop main-process changes:
- the `AuditReporter` handles pacing, the `dropped` clamp, stopping on 403 and waiting for accounts;
- the `ServerClient` exposes `Retry-After`;
- the sequence runner fixes the run outcome;
- the send exchange builds the failed-send URL.

The server's only change is one new meta capability, so the renderer can hide a switch an older server ignores. No migration.

**Tech Stack:** TypeScript on Node 24, Electron main + React renderer, Fastify server, zod 4, Vitest 5.

**Spec:** `docs/specs/2026-10-03-wirebench-desktop-audit-events-design.md` (§2.4 Delivery, §2.1 The setting) and issue #213. The rulings below were made while planning.

## Global Constraints

- **Server bound:** `dropped` is at most **1,000,000** (`desktopAuditBatchSchema`, `packages/engine/src/server-api/audit.ts:208`). It becomes `DESKTOP_AUDIT_LIMITS.maxDropped = 1_000_000` and the schema uses the constant.
- **Back-off** stays at 5 s doubling to 300 s (`AUDIT_BACKOFF_START_MS`, `AUDIT_BACKOFF_MAX_MS`). A `Retry-After` never pushes a delay past 300 s.
- **Capability:** the new meta capability is named `desktop-activity`. It is added by the `audit-log` module's `register` (`packages/server/src/audit-log/module.ts`), next to `addCapability('audit-log')`.
- **Renderer imports:** the renderer imports only **types** from `shared/wire-types.ts`. An eager value import breaks every e2e test through the CSP zod probe.
- **No product names:** never name which product inspired a feature (`pnpm check:banned-terms`).
- **Gate:** `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit, with `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`.
- **Commits:** one per task, subject ending `(#213)`, no `Co-Authored-By` or `Claude-Session` trailer. No local e2e.

## Rulings made while planning

1. **`dropped` is clamped:** the desktop sends `min(count, maxDropped)` and subtracts only what it sent. The remainder goes in the next batch.
2. **`afterFetch` never cancels a pending back-off timer:** with a timer armed it only clears `signedOut`, and the timer sends when it fires. With no timer it flushes as today.
3. **429 with `Retry-After`:** the next delay is `min(max(backoff, retryAfterMs), AUDIT_BACKOFF_MAX_MS)`. The server sends `Retry-After` in seconds, but an HTTP-date is parsed too. The `ServerClient` puts `retryAfterMs` in the error's `details` for any status that carries the header.
4. **A stop records its reason.**
   - A `409 audit-desktop-recording-off` stop is lifted as today, by a fetch that says the workspace records.
   - A `403` or `404` stop is lifted only by a target whose `role` differs from the role held when it stopped, or by a different workspace or server.
   - `AuditTarget` gains `role: WorkspaceRole | undefined`, taken from the fetched head (`open.sync?.status().role`), and `sameTarget` compares it.
5. **A run that errors after `abort()` reports `cancelled`:** the catch in `sequence-runner.ts:306-315` passes `active.controller.signal.aborted` instead of `false`.
6. **`enqueue` awaits accounts first:** it awaits `accounts.ready` before it looks up the account. `AccountService.ready` already exists (`account-service.ts:87`) and never rejects. The deps type becomes `TokenSource & Pick<AccountService, 'list' | 'ready'>`.
7. **The failed REST send's URL has credentials applied:** it is built the way a successful send's request URL is, with the auth query parameters (an API key in the query) applied, then masked by `requestSentEvent` as now. Reuse the engine function that applies auth to the URL; do not re-implement it.
8. **The switch needs the capability:** the *Record desktop activity* switch is shown to an admin only when the server's meta lists `desktop-activity`. Without it, the switch and the "Desktop activity is recorded" note are both hidden.

## Tasks

### Task 1: Reporter pacing — the `dropped` clamp, `afterFetch` and `Retry-After`

**Files:**
- `packages/engine/src/server-api/audit.ts`: add `maxDropped` to `DESKTOP_AUDIT_LIMITS` (line 163), and use it in the schema (line 208).
- `apps/desktop/src/main/server-client.ts`: in `throwProblem` (lines 673-683), when the response has `retry-after`, set `details.retryAfterMs`. Accept a whole number of seconds or an HTTP-date; ignore anything else.
- `apps/desktop/src/main/audit/reporter.ts`:
  - `drain` (lines 166-171): clamp `dropped`, and call `clearDropped(sent)`.
  - `afterFetch` (lines 128-131): Ruling 2.
  - `drainLoop`: Ruling 3. Carry the `retryAfterMs` of the last failure out of `drain`.

Tests:
- `apps/desktop/test/audit-reporter.test.ts`, which already has the `Clock`, `setup` and real-outbox helpers:
  - A local count of 1,500,000 sends 1,000,000, then 500,000, then nothing.
  - With a back-off timer pending, `afterFetch()` sends nothing until the timer fires.
  - With no timer, `afterFetch()` sends at once.
  - A 429 with `retryAfterMs: 60_000` schedules 60 s on the first failure, where it would otherwise be 5 s.
  - A `Retry-After` of 900 s is capped at 300 s.
- `apps/desktop/test/server-client-audit.test.ts`: a 429 with `retry-after: 30` gives `details.retryAfterMs === 30_000`; an HTTP-date is parsed; a garbage value is ignored.

- [ ] Write the tests first, then implement, gate and commit `fix(desktop): audit reporting clamps dropped counts and keeps its back-off pace (#213)`.

### Task 2: Reporter stops — 403 until the role changes, and waiting for accounts

**Files:**
- `apps/desktop/src/main/audit/reporter.ts`:
  - `AuditTarget` gets `role`; `sameTarget` compares it.
  - A stop reason, `'recording-off' | 'forbidden'`, plus the role held at the stop.
  - `setTarget`: Ruling 4.
  - `enqueue`: Ruling 6.
- `apps/desktop/src/main/workspace-service.ts`: `auditTargetOf` (lines 1628-1639) passes the role.

Tests, in `audit-reporter.test.ts`:
- After a 403, fetches with the same target and role send nothing, and the stub client is called once.
- A fetch with a changed role (`viewer` → `editor`) sends again.
- A 409 stop still lifts on a recording fetch (keep the existing test green).
- A 404 behaves like a 403.
- An event enqueued while `ready` is unresolved is queued under the account that loads afterwards, not counted as dropped.
- With `ready` resolved and no account, the event is still only counted as dropped.

Also cover the `auditTargetOf` role pass-through in the existing workspace-service test that covers `onAuditTarget`, if there is one; otherwise test it at the reporter seam.

- [ ] Write the tests first, then implement, gate and commit `fix(desktop): audit reporting waits for accounts and stays off after a 403 until the role changes (#213)`.

### Task 3: What is reported — a cancelled run, and the failed REST URL

**Files:**
- `apps/desktop/src/main/sequence-runner.ts`, lines 306-315: Ruling 5.
- `apps/desktop/src/main/send/exchange.ts`, `failedAudit` (lines 1322-1352): Ruling 7. Find the function the engine uses to put auth into the request URL (start from where `exchange.rest.request.url` is produced) and call it.

Tests:
- `apps/desktop/test/sequence-runner.test.ts`, next to the audit tests at lines 286-370: a run whose step throws after `cancel()` reports `outcome: 'cancelled'`.
- `apps/desktop/test/send-exchange-audit.test.ts`, near line 96: a failed REST send to `http://127.0.0.1:1` with API-key-in-query auth reports a URL containing `api_key=` with the key's value absent. Change the comment at line 107 to match.

- [ ] Write the tests first, then implement, gate and commit `fix(desktop): report a cancelled run as cancelled and a failed REST send's URL with auth applied (#213)`.

### Task 4: Send-report coverage

**Files:**
- `apps/desktop/test/send-exchange-audit.test.ts`, extended, or a sibling file if it grows past about 400 lines.
- Use the existing test servers and deps of the SOAP, gRPC and WebSocket send tests (`send-exchange-soap/grpc/ws` tests), and `sendDepsFor` (`test/helpers/send-deps.ts`).

Tests (test-only unless one exposes a bug; fix any bug in the same commit and say so in its body):
- A SOAP send reports `request.sent` with the endpoint URL masked.
- A gRPC send reports its target.
- A WebSocket connect reports its URL.
- One failed send each for SOAP, gRPC and WebSocket.
- A History resend (`src/main/ipc/history.ts`) and an HTTP log resend (`src/main/ipc/log.ts`) report `request.sent` through the same hook.
- A send made under environment A, then B, reports each with its own environment name.

- [ ] Write the tests, gate and commit `test(desktop): cover SOAP, gRPC, WebSocket, resend and multi-environment send reports (#213)`.

### Task 5: The switch, shown only where the server has the setting

**Files:**
- `packages/server/src/audit-log/module.ts`: `ctx.meta.addCapability('desktop-activity')`.
- The server meta test that lists capabilities.
- On the desktop, follow how `apps/desktop/src/main/workspace-share.ts` reads `capabilities`. Make the flag reach the renderer's team state, and gate the switch and the note in `apps/desktop/src/renderer/features/team/workspaces-tab.tsx` (lines 57-69 and 94-98).

Tests:
- Server: meta lists `desktop-activity`.
- Renderer (`apps/desktop/test/renderer/team-workspaces.test.tsx`):
  - An admin on a server with the capability sees the switch.
  - Without it, the admin sees neither the switch nor the note, and no PATCH is sent.
- Main or store: the capability is carried through.

- [ ] Write the tests first, then implement, gate and commit `fix(desktop): hide the desktop-activity switch on servers without the setting (#213)`.

### Task 6: Docs

**Files:**
- Spec §2.4: the clamp, `Retry-After`, the 403/404 stop lasting until the role changes, waiting for accounts.
- Spec §2.1: the switch needs the `desktop-activity` capability.
- The desktop-activity part of `docs-site/src/content/docs/guides/server-audit-log.mdx`, where it states any of these.
- `CHANGELOG.md`: one line under the audit-log entry.

- [ ] Run `pnpm check:banned-terms` and the docs build, then gate and commit `docs: desktop activity reporting edge cases (#213)`.

## After the last task

1. A final review of the #213 range, then one fix wave.
2. `pnpm test:perf`, then push `feat/audit-log`.
3. Open a PR that closes #213.
4. Merge with `gh pr merge --merge` only when the owner asks.

## Open questions

None.
