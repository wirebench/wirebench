# Wirebench Server `scheduled-runs` Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** On Enterprise, Wirebench Server runs a shared workspace's suites on a cron schedule, keeps
each run's per-request results by age, alerts by email, Slack, Microsoft Teams and webhook with
recovery and muting, and writes schedules and runs to the audit log.

**Architecture:** The CLI's run orchestration moves into the engine as `runSuite`, which the CLI and
the server share. A new `scheduled-runs` server module (`packages/server/src/schedules/`) owns four
tables. It also owns:

- a scheduler that claims due schedules with `skip locked`;
- an executor that materialises the workspace snapshot to a private temporary directory and calls
  `runSuite`;
- an alert outbox with a delivery worker;
- a retention sweeper.

Routes sit behind `requireWorkspaceRole` and then `requireFeature('scheduled-runs')`.

**Tech Stack:** TypeScript on Node 24, Fastify, Postgres (`pg`), zod 4, `ulidx`, `croner` (cron next
fire in a zone), `nodemailer` (SMTP), Vitest.

**Spec:** `docs/specs/2026-10-13-wirebench-server-scheduled-runs-design.md` (issue #343).

## Global Constraints

- Every route needs the workspace role first, then `env.license().requireFeature('scheduled-runs')`.
  Writes need admin; reads need viewer.
- Secrets and alert URLs are sealed with `hooks/secret-box.ts` under
  `WIREBENCH_SERVER_SCHEDULES_SECRET_KEY` and are never returned. Reads give hints only.
- A scheduled run's `${#System#…}` scope is empty, never `process.env`.
- Stored results, alert payloads and audit details are masked; no secret value reaches a row.
- `wirebench run`'s flags, output and exit codes do not change. The existing CLI tests are the
  oracle for PR 1.
- Audit actions are a closed list. Each new action gets a test, or the coverage test fails.
- The migration number is the next free global number (`0014` on main at planning time). Re-check it
  before PR 2 merges.
- New dependencies go through `pnpm licenses:third-party`.
- No test sleeps: use `manualTimers()` and injected `now`.
- Docs and code never name which product inspired a feature (`pnpm check:banned-terms`).
- `WIREBENCH_SKIP_PERF=1 pnpm check` is green before every commit, with one commit per task. No
  `Co-Authored-By` or `Claude-Session` trailer. Commits are made as Mohammed Naami
  <m.naami@outlook.com>.
- Server integration tests run against real Postgres: start it with
  `docker compose -f packages/server/compose.yaml up -d db`, then set
  `WIREBENCH_SERVER_TEST_DATABASE_URL=postgres://wirebench:wirebench@127.0.0.1:5432/wirebench_test`.
  Run them before each server commit.
- After pulling main, run `pnpm -r --filter "./packages/*" build`.

## Pull requests

| PR | Tasks | Closes |
| --- | --- | --- |
| 1 — engine `runSuite` | 1–3 | Refs #343 |
| 2 — module core | 4–9 | Refs #343 |
| 3 — scheduler and executor | 10–15 | Refs #343 |
| 4 — alerts and docs | 16–21 | Closes #343 |

---

## PR 1 — engine `runSuite`

### Task 1: system scope is injectable

**Files:** `packages/engine/src/run/context.ts`, `packages/engine/test/run/context.test.ts`

- [ ] Test: `scopesFor` with `context.system = {}` expands `${#System#HOME}` to nothing, and
  `withSystemValuesReported` reports from `context.system`. Without `system`, behaviour is unchanged
  (`process.env`).
- [ ] Add `system?: Readonly<Record<string, string | undefined>>` to `RunContext`. `scopesFor` passes
  `context.system ?? process.env`, and `withSystemValuesReported` takes the system map as a parameter.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check`, then commit `feat(engine): let a run supply its own system scope`.

### Task 2: move the run orchestration into `runSuite`

**Files:**

- New: `packages/engine/src/run/suite.ts`, `packages/engine/src/run/mask.ts`,
  `packages/engine/src/run/report.ts`.
- Moved out of CLI: `pickEnvironment`, `selectSequences`, `resolveSteps`, `withDefaultSla`,
  `runSequences`, the selection helpers, the `JsonReport` request-entry shape, `createSecretMasker` and
  `maskRequestResult`.
- Tests: `packages/engine/test/run/suite.test.ts`.

- [ ] Test, parity first: for the CLI fixtures under `packages/cli/test/fixtures/runner-project`, `runSuite` gives
  the same `RunResult` (timings stripped) as `runCommand` does today:
  - plain selection;
  - sequences;
  - data rows with the `stop`, `wrap` and `repeat-last` overruns;
  - baseline compare;
  - a missing secret;
  - a protected environment under `'refuse'`, which gives the `environment-protected` refusal.
- [ ] Implement `runSuite(input): Promise<SuiteOutcome>`, where `SuiteOutcome` is
  `{ kind: 'ran', result, masker } | { kind: 'refused', code, message }`. Inputs:
  - `projectDir`, `workspace?`, `environment?`, `select?`, `sequences?`, `data?`, `overrides?`;
  - `host`, `secrets(name)`, `system`, `signal`;
  - `timeoutMs?`, `insecure?`, `bail?`, `defaultSlaMs?`, `requireAssertions?`, `baselineRequire?`;
  - `protectedEnvironments: 'warn' | 'refuse' | 'allow'`, `pace?`, `onRequestDone?`.

  It creates and disposes the script sandbox and checker, and seeds the masker with every secret
  value the run obtains.
- [ ] Re-export everything from `packages/engine/src/run/index.ts`.
- [ ] Check and commit `feat(engine): runSuite, the run orchestration as a library`.

### Task 3: the CLI calls `runSuite`

**Files:** `packages/cli/src/commands/run.ts`, `packages/cli/src/commands/sequence.ts`,
`packages/cli/src/ops/environment.ts`, `packages/cli/src/reporters/{mask,json}.ts`

- [ ] `runCommand` keeps argument parsing, workspace lookup, `cliSecrets`, reporters,
  `--update-baseline` and exit codes, and delegates the run to `runSuite`. The moved helpers are
  deleted from the CLI and imported from the engine.
- [ ] The whole CLI test suite passes with no test edited, except for import paths.
- [ ] Check and commit `refactor(cli): run through the engine's runSuite`. Then open PR 1, "Refs #343".

## PR 2 — module core

### Task 4: wire schemas, feature and audit actions

**Files:** `packages/engine/src/server-api/schedules.ts` (new), `server-api/audit.ts`,
`server-api/licensing.ts`, `server-api/index.ts`, engine tests

- [ ] Tests: schema round-trips for the following, plus the limits (100 schedules a workspace, 20
  addresses, `muteAfter` 0–100, `timeoutMinutes` 1–120):
  - `scheduleCreateSchema`, `scheduleUpdateSchema`, `scheduleSchema` (secrets and targets as hints);
  - `scheduleSecretsSchema`, `alertTargetInputSchema` (a union of email, slack, teams and webhook);
  - `scheduleRunSchema`, `scheduleRunPageSchema`, `scheduleRunDetailSchema`.
- [ ] `FEATURES` gains `'scheduled-runs'`.
- [ ] `AUDIT_ACTIONS` gains `schedule.created`, `schedule.updated`, `schedule.deleted`,
  `schedule.secrets_set`, `schedule.run_requested`, `schedule.run_cancelled` and
  `schedule.run_finished`. The group `schedule` and the target kind `schedule` are added.
- [ ] Check and commit `feat(engine): scheduled-runs wire schemas, feature key and audit actions`.

### Task 5: cron

**Files:** `packages/server/src/schedules/cron.ts`, `test/unit/schedules/cron.test.ts`, the
`croner` dependency, `pnpm licenses:third-party`

- [ ] Tests:
  - five-field validation (ranges, lists, steps, names);
  - presets `@hourly`, `@daily` and `@weekly`, plus `every 5m` and `every 2h`, which canonicalise to
    cron;
  - `every 7m` refused;
  - an invalid zone refused;
  - `nextFire(cron, zone, after)` across DST in Europe/Vienna and America/New_York;
  - after a 3-day gap, the next fire is the next one after *now*.
- [ ] `parseSchedule(text, zone): { cron } | Problem` and `nextFire(cron, zone, after): Date`, built
  on `croner` with `legacyMode` off.
- [ ] Check and commit `feat(server): cron parsing and next fire for schedules`.

### Task 6: migration, config and module skeleton

**Files:** `migrations/scheduled-runs/0014_scheduled-runs.sql`, `src/config.ts`,
`src/schedules/module.ts`, `src/schedules/settings.ts`, `src/context.ts` (module name),
`src/modules.ts`, `test/unit/config.test.ts`, `test/integration/schedules/migrate.test.ts`, generated
config docs

- [ ] Tests:
  - config accepts and refuses each new variable (spec §7);
  - `SECRET_KEY` must decode to 32 bytes;
  - `SMTP_URL` must be `smtp:` or `smtps:`;
  - `ALERT_HOSTS` parses wildcards;
  - the migration applies on a fresh schema, after 0013.
- [ ] The module is registered after `live-updates`. With `SCHEDULES_ENABLED=false` it adds no routes.
- [ ] `pnpm docs:server-config`. Check and commit
  `feat(server): scheduled-runs migration, configuration and module`.

### Task 7: repository and sealing

**Files:** `src/schedules/{repo,seal,errors}.ts`, `test/integration/schedules/repo.test.ts`,
`test/unit/schedules/seal.test.ts`

- [ ] Tests:
  - insert, get, list (by workspace), update, delete with cascade;
  - the unique name per workspace gives `schedules-name-taken`;
  - the secrets map merges, and `null` removes;
  - URL sealing round-trips, and the hint is host plus last four;
  - a missing key gives `schedules-secret-key-missing`.
- [ ] Implement in the `ci-tokens/repo.ts` style.
- [ ] Check and commit `feat(server): schedules repository with sealed secrets and alert URLs`.

### Task 8: schedule routes

**Files:** `src/schedules/routes.ts`, `test/integration/schedules/routes.test.ts`

- [ ] Tests, on `licensingHarness` with Enterprise and without:
  - `GET`, `POST`, `GET :id`, `PATCH` and `DELETE`, plus `PUT …/secrets`;
  - the role matrix: viewer reads, editor reads, admin writes, no role gives 404;
  - 403 `licensing-feature-required` without the feature;
  - validation problems (cron, zone, target, alert target, https only, the alert-host allow-list,
    `schedules-smtp-missing` for email without SMTP);
  - the limit of 100;
  - `next_run_at` set on create and on a cron or zone change, and cleared on disable.
- [ ] Check and commit `feat(server): schedule routes`.

### Task 9: audit on every schedule write

**Files:** `src/schedules/routes.ts`, `test/integration/schedules/audit.test.ts`

- [ ] Tests:
  - `schedule.created`, `schedule.updated` (changed fields, and the `allowProtected` and
    `insecureTls` flips), `schedule.deleted` and `schedule.secrets_set` (names only), each in the
    write's transaction;
  - a forced audit failure rolls the write back;
  - `expectNoSecretsInAudit`.
- [ ] Check and commit `feat(server): audit schedule changes`. Then open PR 2, "Refs #343".

## PR 3 — scheduler and executor

### Task 10: materialise a snapshot

**Files:** `src/schedules/materialise.ts`, `test/integration/schedules/materialise.test.ts`

- [ ] Tests:
  - writes `workspace.yaml`, `environments/**` and `projects/<slug>/**` from
    `CommitStore.snapshot` into `<dataDir>/tmp/schedules/<runId>/`, with mode 0700 and base64 files
    decoded;
  - refuses past the size cap with `snapshot-too-large`;
  - refuses a path that escapes the directory;
  - `dispose()` removes the directory.
- [ ] Check and commit `feat(server): materialise a workspace snapshot for a run`.

### Task 11: executor

**Files:** `src/schedules/executor.ts`, `test/integration/schedules/executor.test.ts`

- [ ] Tests run against a seeded workspace and a local HTTP fixture server:
  - a passing run stores its summary and results and becomes `passed`;
  - a failing assertion gives `failed`;
  - an unreachable host gives `errored`;
  - a missing project gives `errored` with `target-missing`;
  - a protected environment gives `environment-protected`, unless `allowProtected`;
  - a sealed secret is used and appears in no stored row;
  - `${#System#…}` expands to empty;
  - the timeout aborts the run, which ends `errored` with `timeout`;
  - `schedule.run_finished` is recorded with counts and the commit;
  - the temporary directory is gone in every case.
- [ ] Check and commit `feat(server): execute a scheduled run with runSuite`.

### Task 12: scheduler

**Files:** `src/schedules/scheduler.ts`, `test/integration/schedules/scheduler.test.ts`

- [ ] Tests use `manualTimers` and an injected `now`:
  - a due schedule is claimed once across two schedulers (`skip locked`);
  - `next_run_at` advances past now, and missed fires collapse to one;
  - an open run gives a `skipped` run with `overlap`;
  - the concurrency cap is honoured, and queued runs go oldest first;
  - no feature means nothing is claimed;
  - `stop()` aborts running runs, which become `cancelled` with `shutdown`;
  - boot marks stale `running` runs `errored` with `interrupted`.
- [ ] Check and commit `feat(server): schedule runs on their cron`.

### Task 13: run routes

**Files:** `src/schedules/routes.ts`, tests

- [ ] Tests:
  - `POST …/runs` queues a run and records `schedule.run_requested`, subject to overlap;
  - `GET …/runs` gives cursor paging and a status filter, and a bad cursor gives
    `schedules-cursor-invalid`;
  - `GET …/runs/:runId` returns results with `exchange` only for failed and errored results;
  - `DELETE …/runs/:runId` cancels and records `schedule.run_cancelled`, and a finished run gives
    `schedules-run-finished`.
- [ ] Check and commit `feat(server): run-now, run history and cancel routes`.

### Task 14: live message and retention

**Files:** `src/context.ts` (`scheduleRunFinished` announcement), `src/live/module.ts`,
`packages/engine/src/server-api/live.ts`, `src/schedules/sweep.ts`, tests

- [ ] Tests:
  - a subscriber of the workspace receives `{ type: 'schedule-run', … }` after a run finishes, and a
    socket of another workspace does not;
  - the sweeper deletes runs older than the maximum age in batches, plus delivered and dead outbox
    rows older than 7 days, and stops on close.
- [ ] Check and commit `feat(server): live schedule-run message and run retention`.

### Task 15: admin command line

**Files:** `src/schedules/cli.ts`, `src/args.ts`, `test/unit/args.test.ts`,
`test/integration/schedules/cli.test.ts`

- [ ] Tests: `admin schedules list`, `enable`, `disable` and `runs` (NDJSON), with no license
  needed, and `enable` and `disable` audited with the `system` actor.
- [ ] Check and commit `feat(server): admin schedules commands`. Then open PR 3, "Refs #343".

## PR 4 — alerts and docs

### Task 16: alert state machine

**Files:** `src/schedules/alerts/state.ts`, `test/unit/schedules/alert-state.test.ts`

- [ ] A table test of spec §3.4: first failure, the streak up to `muteAfter` (with the muted notice on
  the last alert), silence after it, recovery when muted, `muteAfter: 0` never mutes, and skipped and
  cancelled runs are ignored.
- [ ] Check and commit `feat(server): alert state for schedules`.

### Task 17: renderers

**Files:** `src/schedules/alerts/render.ts`, `test/unit/schedules/alert-render.test.ts`

- [ ] Golden tests: email (subject, text and HTML), Slack blocks, a Teams Adaptive Card, and the
  webhook JSON, for failure, muted-failure and recovery. They show at most three failing requests,
  include the run link from `publicUrl`, and carry no bodies.
- [ ] Check and commit `feat(server): render schedule alerts`.

### Task 18: delivery

**Files:** `src/schedules/alerts/{https,smtp}.ts`, the `nodemailer` dependency,
`pnpm licenses:third-party`, tests

- [ ] Tests:
  - HTTPS delivery: https only, no redirects followed, a 10 s deadline, the allow-list, and the HMAC
    `X-Wirebench-Signature` when a secret is set;
  - SMTP delivery against an in-process SMTP sink.
- [ ] Check and commit `feat(server): deliver schedule alerts over HTTPS and SMTP`.

### Task 19: outbox and wiring

**Files:** `src/schedules/alerts/outbox.ts`, `src/schedules/executor.ts`, tests

- [ ] Tests:
  - a finished run updates the alert state and enqueues one row per target in the same transaction;
  - the worker delivers, retries with backoff from 5 s to 300 s, and marks a row `dead` after 8
    attempts;
  - the license is rechecked before each pass;
  - `POST …/alerts/test` sends synchronously and returns per-target results.
- [ ] Check and commit `feat(server): alert outbox for schedules`.

### Task 20: docs

**Files:**

- New: `docs-site/src/content/docs/guides/server-scheduled-runs.mdx`.
- Changed: `server-licensing.mdx` (Enterprise features list), `docs/roadmap.md` (item status),
  `packages/server/README.md`.

- [ ] The page covers setup (the key, SMTP, the allow-list), cron and zones, targets, secrets, alerts
  and muting, retention, run history over the API, the admin commands, and the security notes from
  spec §6.
- [ ] `pnpm check:banned-terms`. Check and commit `docs: scheduled runs and monitors on the server`.

### Task 21: revisions and follow-ups

- [ ] Append "Revisions after planning" to the spec with any rulings made while building.
- [ ] File the follow-up issues for spec §13: the desktop Schedules tab, server secret sources, and
  latency trends.
- [ ] Check and commit `docs: scheduled-runs revisions after building`. Then open PR 4, "Closes #343",
  and move #343 to In review.
