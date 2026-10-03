# Desktop events in the server audit log — Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** When a workspace admin turns on *Record desktop activity*, every desktop reports each request sent and each test-suite run in that workspace to the team server's audit log, durably and with the URL masked.

**Architecture:** A `record_desktop_activity` column on `workspaces` (migration 0009, `teams-access`) is set through `PATCH /workspaces/:id` and travels to desktops in the sync head. A new route in the `audit-log` module, `POST /workspaces/:id/audit/desktop-events`, records batches through the existing `recordAudit` hook. On the desktop, the single send path (`sendThroughEngine`) and the sequence runner hand events to a reporter that writes them to a per-workspace outbox and flushes it with backoff.

**Tech Stack:** TypeScript on Node 24, Fastify, Postgres (`pg`), zod 4, Electron main, React + zustand, Vitest 5.

**Spec:** `docs/specs/2026-10-03-wirebench-desktop-audit-events-design.md`, which revises `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` §1.2.

## Global Constraints

- Everything in the audit-log plan's Global Constraints still holds (`docs/plans/2026-10-02-wirebench-server-audit-log-plan.md`), except that the desktop now originates the three `desktop.*` events through the new route. That route is the only write path; it never updates or deletes.
- Off by default. The desktop reports only while its last fetched head said `recordDesktopActivity: true`; the server refuses a batch for a workspace that does not record (`409 audit-desktop-recording-off`).
- Reported details never carry headers, bodies, responses, or an unmasked URL. The URL goes through `redactUrl(url, { show: false })`, then `redactSecretValues`, then a 2048-character cut, before it is written to the outbox.
- The actor, `at`, `teamId` and `workspaceId` come from the server, never from the body.
- Sends with `options.run === true` (test-suite steps) are not reported individually.
- New problem code: `audit-desktop-recording-off` (409). A CI token on the route: the existing forbidden problem (403).
- Limits: batch ≤ 100 events; outbox ≤ 5000 events; backoff 5 s doubling to 300 s; `hosts` ≤ 64.
- The renderer imports only **types** from `shared/wire-types.ts`.
- Never name which product inspired a feature (`pnpm check:banned-terms`).
- `WIREBENCH_SKIP_PERF=1 nice pnpm check` green before every commit. One commit per task, subject ending `(#211)`. No `Co-Authored-By` or `Claude-Session` trailer. No local e2e.
- Server integration suites build on `licensingHarness(testKeys(), { extra })` and run against Postgres (`WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`). Migration 0009 must keep the combined list contiguous.

## Rulings made while planning

1. Runs are test-suite (sequence) runs only; the app has no load runs.
2. Step sends inside a run are covered by `desktop.run_finished`, not reported one by one.
3. The flag rides the sync head (already polled) and `TeamWorkspace`; no new polling.
4. The route needs `viewer` on the workspace: anyone who can send can report. CI tokens are refused.
5. A 409 deletes that workspace's outbox: an admin who turned recording off does not want late events.
6. Outbox overflow drops the oldest and reports the count as `desktop.events_dropped`, so a gap is on the record.
7. `at` is receipt time; the desktop's time is `details.sentAt`. Keyset paging stays on `at`.
8. The desktop records failed sends too (`outcome: 'failed'`, `status: null`), but not prepare-stage failures, which never reach the network.
9. A WebSocket or gRPC streaming session reports once, when its send result is known, like History.

## Tasks

### Task 1: Engine wire shapes

**Files:** Modify `packages/engine/src/server-api/audit.ts`, `packages/engine/src/server-api/teams.ts`, `packages/engine/src/server-api/sync.ts`, `packages/engine/src/index.ts`. Test `packages/engine/test/unit/server-api/audit.test.ts` (extend) and the teams/sync schema tests if present.

**Interfaces produced:**
- `AUDIT_ACTIONS` gains `'workspace.desktop_recording_changed'`, `'desktop.request_sent'`, `'desktop.run_finished'`, `'desktop.events_dropped'`. `AUDIT_ACTION_GROUPS` gains `'desktop'`.
- `DESKTOP_AUDIT_LIMITS = { maxBatch: 100, maxOutbox: 5000, maxUrlLength: 2048, maxHosts: 64 } as const`.
- `desktopRequestSentDetailsSchema`: strict object `{ protocol: enum rest|soap|grpc|websocket, method: string(1..256)|null, url: string(1..2048), status: int|null, outcome: enum ok|failed, durationMs: int ≥ 0, environment: string(1..256)|null, requestId: string(1..128), requestName: string(0..256), sentAt: ISO datetime }`.
- `desktopRunFinishedDetailsSchema`: strict `{ sequenceId: string(1..128), name: string(0..256), outcome: <the engine's SequenceRunResult outcome values, plus 'cancelled' if not already one>, passed, failed, errored, skipped: int ≥ 0, durationMs: int ≥ 0, hosts: array of string(1..2048) max 64, environment: string|null, startedAt: ISO, sentAt: ISO }`.
- `desktopAuditEventSchema`: discriminated union on `action` (`'desktop.request_sent'` with `details: desktopRequestSentDetailsSchema`, `'desktop.run_finished'` with its schema).
- `desktopAuditBatchSchema`: `{ events: array(desktopAuditEventSchema).max(100), dropped: int ≥ 1 optional }`, refined so that `events.length > 0 || dropped !== undefined`.
- Types `DesktopAuditEvent`, `DesktopAuditBatch`, `DesktopRequestSentDetails`, `DesktopRunFinishedDetails`.
- `teamWorkspaceSchema` gains `recordDesktopActivity: z.boolean()`; `teamWorkspaceUpdateRequestSchema` gains `recordDesktopActivity: z.boolean().optional()`.
- The sync head response schema gains `recordDesktopActivity: z.boolean()`.

- [ ] Tests first: the new actions and group exist; a valid request-sent and run-finished event parse; unknown keys, a 2049-char URL, 65 hosts, 101 events, and an empty batch without `dropped` are refused; `{ events: [], dropped: 3 }` parses; the workspace and head schemas require the flag.
- [ ] Implement; export everything from the engine index; gate; commit `feat(engine): desktop audit event shapes and the workspace recording flag (#211)`.

### Task 2: Server — the workspace setting

**Files:** Create `packages/server/migrations/teams-access/0009_desktop-recording.sql`. Modify `packages/server/src/teams/repo.ts` (`WorkspaceRow.recordDesktopActivity`, `WORKSPACE_SELECT`, `updateWorkspace` patch field), `packages/server/src/teams/routes/workspaces.ts` (`toWorkspace`, PATCH), the sync head route (where `role` is set in the head response under `packages/server/src/sync/`), and every test fixture that builds a `TeamWorkspace` or a head. Tests: extend the teams workspace route tests and the audit fire-site tests for workspaces.

- [ ] Migration: `alter table workspaces add column record_desktop_activity boolean not null default false;`. Confirm `allMigrations` accepts 0009 after 0008 with the licensing harness, and that every harness that loads `teams-access` without `audit-log` still has a contiguous list (fix the harnesses if not).
- [ ] PATCH: when `recordDesktopActivity` changes, `recordAudit(..., { action: 'workspace.desktop_recording_changed', target: { kind: 'workspace', id }, workspaceId, teamId, details: { enabled, previous } })` in the same transaction, and `announce(hooks.accessChanged, ...)` as the default-role change does. Unchanged value: no event.
- [ ] Head response and `toWorkspace` include the flag.
- [ ] Tests (Postgres): default false; an admin turns it on and the event is written with `{ enabled: true, previous: false }`; the same value again writes nothing; an editor gets 403; the head shows the flag.
- [ ] Gate; commit `feat(server): a workspace admin turns desktop recording on, and the head carries it (#211)`.

### Task 3: Server — the reporting route

**Files:** Create `packages/server/src/audit-log/desktop-routes.ts`, register it in `packages/server/src/audit-log/module.ts`; add the problem to the module's errors file. Test `packages/server/test/integration/audit-log/desktop-events.test.ts`.

- [ ] `POST /api/v1/workspaces/:workspaceId/audit/desktop-events`, preHandler `requireWorkspaceRole(db, 'viewer')`. Refuse a CI-token caller (no `request.caller`) with the host's forbidden problem. Parse the body with `desktopAuditBatchSchema` (400 on failure, the host's usual validation problem). If the workspace's `recordDesktopActivity` is false, `409 audit-desktop-recording-off`.
- [ ] In one transaction: for each event, `recordAudit(hooks, tx, { ...auditSource(request), action: event.action, target: { kind: 'workspace', id }, workspaceId: id, teamId, details: event.details })`; if `dropped`, one `desktop.events_dropped` with `{ count: dropped }`. Reply 204.
- [ ] Tests (Postgres): off → 409 and nothing written; on → 204 and rows have actor = caller, `at` from the server clock, details as sent; `dropped` alone writes one `desktop.events_dropped`; a viewer can report; no role → 404; a CI token → 403; a bad body → 400 and nothing written; 101 events → 400. Every new action is named in an assertion so `coverage.test.ts` passes.
- [ ] Gate; commit `feat(server): desktops report sends and runs to a workspace that records (#211)`.

### Task 4: Desktop main — masking, outbox and reporter

**Files:** Create `apps/desktop/src/main/audit/desktop-events.ts`, `apps/desktop/src/main/audit/outbox.ts`, `apps/desktop/src/main/audit/reporter.ts`. Modify `apps/desktop/src/main/server-client.ts` (`reportDesktopEvents(url, token, workspaceId, batch)`), `apps/desktop/src/shared/wire-types.ts` (restate the batch and the flags as the file does for other engine shapes). Tests `apps/desktop/test/audit-outbox.test.ts`, `audit-reporter.test.ts`, `audit-desktop-events.test.ts`, and the server-client test for the new call.

**Interfaces produced:**
- `maskAuditUrl(url: string): string` — `redactUrl(url, { show: false })`, then `redactSecretValues`, then cut to 2048.
- `requestSentEvent(input): DesktopAuditEvent` and `runFinishedEvent(result, startedAt, now, environment): DesktopAuditEvent` — pure builders; the run builder counts outcomes from `steps` and collects distinct step `origin`s (max 64).
- `class AuditOutbox(dir)`: `append(event)`, `peek(n)`, `remove(names)`, `clear()`, `dropped()` / `clearDropped()`; files named by a zero-padded sequence, written with `writeFileAtomic`; overflow drops the oldest and adds to a counter kept in `dropped.json` beside them.
- `class AuditReporter` with deps `{ client, accounts, now, setTimeout, clearTimeout }`: `setTarget(target: { url, workspaceId, dir, recording } | undefined)`, `enqueue(event)` (no-op unless recording), `flush()`, `onSignedIn()`, `dispose()`. Flush sends batches of 100 via `withToken`, oldest first, with any dropped count; on success removes them; on `audit-desktop-recording-off` clears the outbox and stops recording until the next `setTarget` with `recording: true`; on `account-signed-out` waits for `onSignedIn`; on a network failure backs off 5 s doubling to 300 s. It never throws into its caller and never runs two flushes at once.
- [ ] Tests with a temp dir and a fake client and clock: order kept across a new outbox on the same dir; the cap drops the oldest and reports `dropped` once; 250 events flush as 100/100/50; 409 clears; offline backs off and retries; signed out keeps files; a non-recording target ignores `enqueue`; a URL with `?api_key=abc`, a password, and a recorded secret in the path is masked.
- [ ] Gate; commit `feat(desktop): an outbox and reporter for desktop audit events, with the URL masked (#211)`.

### Task 5: Desktop main — hooks and wiring

**Files:** Modify `apps/desktop/src/main/send/exchange.ts` (`SendThroughEngineDeps.audit?: (event: DesktopAuditEvent) => void`, called after `record(...)` and after `recordFailure(...)` when `!options.run` and the request belongs to a project), `apps/desktop/src/main/ipc/request.ts` (`toSendDeps`) and any History, log or multi-env caller that builds deps separately; `apps/desktop/src/main/sequence-runner.ts` (report `run_finished` when a run ends, cancelled included); `apps/desktop/src/main/sync/server-state.ts` and the sync service (keep `recordDesktopActivity` from each fetched head with `role`); `apps/desktop/src/main/workspace-service.ts` (expose the reporter target for the open workspace, and `recording` in the share wire); `apps/desktop/src/main/index.ts` (construct the reporter, `setTarget` when a workspace opens or closes and after each fetch, `onSignedIn` on sign-in, `dispose` on quit); `apps/desktop/src/main/ipc/team.ts` (forward `recordDesktopActivity` in `updateWorkspace`); `apps/desktop/src/shared/wire-types.ts` (`workspaceShareWireSchema.server.recording: boolean`).

- [ ] Tests: a send with an audit dep calls it once with the masked URL, status and outcome; a failed send reports `failed`; a run step does not report; a sequence run reports one `run_finished` with counts and hosts; a fetched head's flag reaches the reporter target and the workspace wire; `team.updateWorkspace` forwards the flag.
- [ ] Gate; commit `feat(desktop): sends and test runs in a recording workspace reach the audit log (#211)`.

### Task 6: Renderer — the switch, the notice, the labels

**Files:** Modify `apps/desktop/src/renderer/features/team/workspaces-tab.tsx` (a checkbox *Record desktop activity* under `isAdmin`, a read-only line for others), `apps/desktop/src/renderer/state/team.ts` (patch type), `apps/desktop/src/renderer/shell/status-bar.tsx` (a *Recorded* item with the spec's tooltip while `workspace.share.server.recording`), `apps/desktop/src/renderer/state/audit-format.ts` (group `desktop` → "Desktop activity"; labels "Request sent", "Test run finished", "Events dropped", "Desktop recording changed"), `features/team/audit-detail.tsx` if the URL needs its own line. Tests: `apps/desktop/test/audit-format.test.ts`, a workspaces-tab test, a status-bar test.

- [ ] Tests first, then implement; gate; commit `feat(desktop): the recording switch, the Recorded notice and labels for desktop events (#211)`.

### Task 7: Docs

**Files:** `docs-site/src/content/docs/guides/server-audit-log.mdx` (a *Desktop activity* section: what is recorded and what is not, how to turn it on, the notice, offline delivery, rows in the events table), `packages/server/README.md` (one line in *Audit log*), `CHANGELOG.md` (extend the audit-log entry), `docs/specs/2026-10-01-wirebench-server-audit-log-design.md` (§1.2 points to the new spec).

- [ ] `pnpm check:banned-terms` and the docs build; gate; commit `docs: desktop activity in the audit log guide, README and changelog (#211)`.

## After the last task

Final whole-branch review of the #211 range, one fix wave, `pnpm test:perf`, push to `feat/audit-log`, update PR #207 (it closes #211 too), CI green, merge with `gh pr merge --merge`.

## Open questions

None: the owner decided scope, switch and detail on 2026-10-03.
