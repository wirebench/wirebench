# Wirebench: `scheduled-runs` — design

Date: 2026-10-13 · Status: product questions answered by the owner 2026-10-13 · Module: `scheduled-runs`
of `docs/specs/2026-09-24-wirebench-server-capability-map.md` (editions and compliance epic) · Issue #343

- Builds on:
  - `docs/specs/2026-10-01-wirebench-server-licensing-design.md`: the reserved `scheduled-runs` feature
    key, `requireFeature`, and the `licenseChanged` announcement.
  - `docs/specs/2026-10-01-wirebench-server-audit-log-design.md`: `recordAudit`, `SYSTEM_SOURCE`, the
    closed action list and its coverage test.
  - `docs/specs/2026-09-24-wirebench-server-sync-design.md`: a shared workspace is a bare repository the
    server reads through `CommitStore.snapshot`.
  - `docs/specs/2026-09-26-wirebench-server-live-updates-design.md`: announcements and the live hub.
  - The webhook-capture and webhook-signatures designs: `secret-box.ts` (AES-256-GCM at rest) and the
    sweeper shape.
  - The CLI runner (`docs/cli.md`, `wirebench run`) and the engine's run primitives (`runRequests`,
    `runIterations`, `runSequence`, `planIterations`).
- Decisions recorded here (owner, 2026-10-13):
  - **Enterprise only.** `requireFeature('scheduled-runs')` guards every route, and the scheduler
    checks the license before each tick. A lapsed license pauses schedules; it deletes nothing.
  - **Cron with a time zone.** Five-field cron and an IANA time zone, at most one run a minute.
    `@hourly`, `@daily`, `@weekly` and `every <n>m|h` are accepted and stored as the cron they mean.
  - **Sealed schedule secrets.** A workspace admin sets values per schedule through the API.
    They are write-only and sealed under `WIREBENCH_SERVER_SCHEDULES_SECRET_KEY`.
    `WIREBENCH_SECRET_<NAME>` in the server's environment is the fallback.
  - **Alerts by email (SMTP), Slack, Microsoft Teams and a generic HTTPS webhook**, plus a
    `schedule-run` live-update message so an open desktop can react.
  - **Workspace admins manage schedules.** Editors and viewers read schedules and their run history.
  - **History is kept 90 days by default** (`WIREBENCH_SERVER_SCHEDULES_MAX_AGE_DAYS`, 1–3650). It
    holds per-request results for every run, and masked exchanges for failed and errored requests only,
    64 KiB each.
  - **Protected environments need an explicit `allowProtected: true`** on the schedule, which is
    audited.
  - **No desktop UI in this issue.** A follow-up issue covers a desktop Schedules tab, mockup first.

## Assumptions I'm making

1. **A run uses the workspace's main head at the moment it fires.** A schedule names a project, an
   optional selection and an environment, never a commit. A run records the commit it ran.
2. **The server materialises the snapshot to a private temporary directory** under
   `<dataDir>/tmp/schedules/<runId>/`, runs it with the engine's disk loaders, and deletes the directory
   when the run ends. Keystores, attachments, data files and goldens all resolve as they do for the CLI.
3. **What `wirebench run` does moves into the engine** as `runSuite`, which the CLI and the server
   share. The CLI's flags, output and exit codes do not change.
4. **`${#System#…}` does not read the server's environment.** A scheduled run's system scope is
   empty. Otherwise any workspace admin could read the server's variables, including its database
   URL, through a request.
5. **Workspace secret sources (vault, cloud CLIs, keychain) are not resolved on the server** in this
   slice. The image carries none of those CLIs, and running them would need operator trust settings.
   A secret the run needs that has neither a sealed value nor a `WIREBENCH_SECRET_*` value fails the
   requests that use it with `secret-missing`, as the CLI does.
6. **Scripts run** in the same capability-free sandbox as everywhere else (ADR-0016).
7. **Baselines are compared, never updated.** A scheduled run is read-only on the repository.
8. **One server process.** The scheduler claims due runs with `for update skip locked`, so a second
   process would not double-fire, but the deployment model stays one replica (ADR-0009).

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

An operations team wants a smoke suite to run every five minutes from inside their own network
against production. When it breaks, they want to hear about it on the channels they already watch,
hear once more when it is fixed, and not be paged forty times overnight. A workspace admin points a
schedule at a project and environment in a shared workspace and adds an email list and a Slack
channel. From then on the server runs the suite, keeps each run's results for three months, and
writes the schedule's life and every run to the audit log.

### 1.1 In scope

- A `scheduled-runs` server module: schedules, sealed per-schedule secrets, alert targets, runs and
  per-request results in Postgres.
- A scheduler that fires due schedules, and an executor that runs a workspace snapshot with the
  engine.
- `runSuite` in the engine: the CLI's run orchestration (environment pick, selection, sequences, data
  rows, baselines, secret needs, masking) as a library the CLI and the server both call.
- Alerts by email, Slack, Microsoft Teams and generic webhook, with failure, recovery and muting.
- REST endpoints, `wirebench-server admin schedules …` commands, audit events, a live-update message,
  retention, and a docs-site page. The editions table names the feature.

### 1.2 Not in scope

- A desktop Schedules tab and run-history view (follow-up issue, mockup first).
- Workspace secret sources on the server, team secrets on the server, and enrolling the server as a
  team-secrets machine.
- Runs that span several workspaces, parallel requests within one run, and load-style concurrency.
- Pinning a schedule to a commit or branch.
- Alerting on latency trends; a run fails on what its assertions and SLAs say, nothing else.

## 2. Concepts

- **Schedule**: a workspace-scoped definition with a name, a cron expression, a time zone, a target,
  options, secrets, alert targets and an enabled flag.
- **Target**: `{ project: <slug>, environment?: <name|slug|id>, select?: string[], sequences?: string[],
  data?: { path, overrun? } }`. The same selectors `wirebench run` takes, with the data file as a path
  inside the project.
- **Run**: one execution. Status is `queued`, `running`, `passed`, `failed`, `errored`, `skipped` or
  `cancelled`. `failed` means an assertion or SLA failed, and `errored` means a request or the run itself
  errored. The CLI's exit codes map onto these: 0 is `passed`, 1 `failed`, 2 and 3 `errored`.
- **Result**: one row per executed request of a run, mirroring the CLI's JSON report entry.
- **Alert state**: per schedule, `ok` or `failing`, with the count of consecutive failing runs and
  whether alerts are muted.

## 3. Behaviour

### 3.1 Scheduling

- The cron expression is evaluated in the schedule's time zone (DST rules from `Intl`), and the next
  fire time is stored as `next_run_at`.
- A tick every 15 seconds claims schedules with `enabled and next_run_at <= now()` using
  `for update skip locked`. For each it inserts a `queued` run and advances `next_run_at` to the next
  fire after *now*. A server that was down skips the fires it missed and runs once on its first tick.
- **No overlap.** If the schedule's previous run is still `queued` or `running`, the new fire is recorded
  as a `skipped` run with reason `overlap`, and no alert is sent.
- **Concurrency.** At most `WIREBENCH_SERVER_SCHEDULES_CONCURRENCY` runs (default 2, range 1–16) execute
  at once across the server. The rest wait as `queued`, oldest first.
- **Run timeout.** Each schedule has a `timeoutMinutes` (default 15, range 1–120). It aborts the run's
  signal, and the run becomes `errored` with reason `timeout`.
- **License.** Before each tick the scheduler checks `features.includes('scheduled-runs')`. Without the
  feature it claims nothing; running runs finish.
- **Shutdown.** `onClose` stops the tick, aborts running runs and marks them `cancelled` with reason
  `shutdown`. At boot, any run still `running` from a crash is marked `errored` with reason
  `interrupted`.
- **Run now.** `POST …/runs` queues a run immediately (workspace admin), subject to the overlap rule.
  It does not move `next_run_at`.

### 3.2 Executing a run

1. Read the workspace head and `snapshot` it. Write `workspace.yaml`, `environments/` and the target
   project's directory to `<dataDir>/tmp/schedules/<runId>/` (mode 0700). Over
   `WIREBENCH_SERVER_SCHEDULES_MAX_SNAPSHOT_MB` (default 50) is `errored` with reason
   `snapshot-too-large`.
2. Load the workspace and the target project with the engine loaders.
   - A project or environment that no longer exists is `errored` with reason `target-missing`.
   - A protected environment without `allowProtected` is `errored` with reason `environment-protected`.
3. Call `runSuite` with these settings:
   - an empty system scope;
   - the secret chain: sealed values first, then `WIREBENCH_SECRET_<NAME>`;
   - one cookie jar for the run;
   - the run's `AbortSignal`;
   - `insecure: false`, unless the schedule sets `insecureTls: true` (an audited option).
4. Mask every string with the run's masker, as the CLI's JSON reporter does. Then store the summary
   and the results in one transaction, set the run's status, and record `schedule.run_finished`.
5. Announce `scheduleRunFinished`, then evaluate alerts (§3.4).
6. Remove the temporary directory, even when an earlier step failed.

### 3.3 Secrets

- `PUT …/secrets` sets the whole map at once, `{ "<NAME>": "<value>" | null }`, where `null` removes a
  name and an absent name is kept. Names follow `envVariablesFor`'s naming.
- Values are sealed with `secret-box.ts` under `WIREBENCH_SERVER_SCHEDULES_SECRET_KEY`, which is 32 bytes
  in base64 and required when the feature is used. Without the key, the secrets route answers
  `schedules-secret-key-missing`, and a schedule with secrets errors with that reason.
- No read route returns a value. A schedule shows each name with `set: true` and the last four
  characters (`hintOf`).
- Every sealed value is seeded into the run's masker before the first send.
- The audit records `schedule.secrets_set` with the names added, changed and removed, never values.

### 3.4 Alerts

A schedule has `alerts: { targets: AlertTarget[], muteAfter: number }`. `muteAfter` defaults to 3, range
1–100, or 0 to never mute. The target kinds are:

- `email`: `{ to: string[] }` (1–20 addresses), sent through the server's SMTP settings.
- `slack`: `{ url }`, a Slack incoming-webhook URL.
- `teams`: `{ url }`, a Microsoft Teams incoming-webhook or workflow URL.
- `webhook`: `{ url, secret? }`. A JSON POST signed with `X-Wirebench-Signature: sha256=<hmac>` when a
  secret is set.

URLs must be `https:` and carry no credentials; they are sealed at rest like secrets, because a chat
webhook URL is itself a credential. Reads show the host and the last four characters only.

State machine per schedule, over finished runs only (`skipped` and `cancelled` runs don't count):

| Previous state | Run outcome | Action |
| --- | --- | --- |
| ok | passed | nothing |
| ok | failed / errored | `failing`, streak 1, send a **failure** alert |
| failing | failed / errored | streak + 1, send a **failure** alert while streak ≤ `muteAfter` (the alert at `muteAfter` says "further failures are muted until it recovers") |
| failing | passed | `ok`, streak 0, send a **recovery** alert (also when muted) |

- An alert carries:
  - the schedule's name, the workspace and project;
  - the environment name, the outcome, the counts and the duration;
  - the first three failing requests, each with its first failing assertion message, already masked;
  - the commit;
  - a link to the run's API resource under `WIREBENCH_SERVER_PUBLIC_URL`.
- An alert never carries bodies.
- **Delivery** goes through an outbox table. Each target is retried with backoff from 5 s to 300 s, at
  most 8 attempts, and then the delivery is marked `dead` and logged. A failed delivery never changes a
  run's outcome.
- **SMTP** is configured with `WIREBENCH_SERVER_SMTP_URL` (`smtp://` or `smtps://`, credentials allowed,
  marked secret) and `WIREBENCH_SERVER_SMTP_FROM`. Without them an email target is refused at save with
  `schedules-smtp-missing`.
- **Egress guard.** Alert targets are written by workspace admins, so `WIREBENCH_SERVER_SCHEDULES_ALERT_HOSTS`
  can name an allow-list of hosts (comma-separated, `*.example.com` wildcards). When it is unset,
  every https host is allowed. Redirects are never followed, and each request has a 10 s deadline.
- **Test.** `POST …/alerts/test` sends a test message to every target synchronously and returns
  per-target results (workspace admin).

### 3.5 Live updates

A new announcement, `scheduleRunFinished { workspaceId, scheduleId, runId, status }`. The live module
turns it into `{ type: 'schedule-run', workspaceId, scheduleId, runId, status }` for subscribers of the
workspace. An older desktop skips a `type` it does not know (`LiveClient`).

### 3.6 Retention

Runs and their results older than `WIREBENCH_SERVER_SCHEDULES_MAX_AGE_DAYS` (default 90, range 1–3650)
are deleted by the reused `CaptureSweeper` shape, 1000 rows at a time. Dead and delivered outbox
rows older than 7 days are deleted with them. Deleting a schedule deletes its runs, results and outbox
rows (cascade).

### 3.7 Endpoints

Every endpoint is under `/api/v1/workspaces/:workspaceId/schedules` and behind
`requireFeature('scheduled-runs')`, checked after the role guard.

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /` | viewer | List schedules with state, next run and last run summary. |
| `POST /` | admin | Create. Validates cron, zone, target shape and alert targets; does not check the project exists (it may arrive in a later push). |
| `GET /:scheduleId` | viewer | One schedule; secrets and URLs as hints. |
| `PATCH /:scheduleId` | admin | Change any field except secrets; `enabled` pauses and resumes. |
| `DELETE /:scheduleId` | admin | Delete with its history. |
| `PUT /:scheduleId/secrets` | admin | §3.3. |
| `POST /:scheduleId/alerts/test` | admin | §3.4. |
| `POST /:scheduleId/runs` | admin | Run now. |
| `GET /:scheduleId/runs` | viewer | Runs, newest first, cursor paged (default 50, max 200), filter by `status`. |
| `GET /:scheduleId/runs/:runId` | viewer | One run with its results; `exchange` present for failed and errored results. |
| `DELETE /:scheduleId/runs/:runId` | admin | Cancel a queued or running run. |

Wire schemas live in `packages/engine/src/server-api/schedules.ts`, beside the other server APIs. Problem
codes are new and prefixed `schedules-`: `schedules-not-found`, `schedules-cron-invalid`,
`schedules-zone-invalid`, `schedules-target-invalid`, `schedules-alert-target-invalid`,
`schedules-alert-host-refused`, `schedules-smtp-missing`, `schedules-secret-key-missing`,
`schedules-run-not-found`, `schedules-run-finished`, `schedules-cursor-invalid`, and
`schedules-limit` (at most 100 schedules per workspace).

### 3.8 Command line

All commands work without a license, for the operator who has the database (as the audit export does).

- `wirebench-server admin schedules list [--workspace <id>]`
- `wirebench-server admin schedules disable <scheduleId>` and `enable <scheduleId>`
- `wirebench-server admin schedules runs <scheduleId> [--limit n]` (NDJSON)

### 3.9 Audit events

New group `schedule` and target kind `schedule`:

- `schedule.created`, `schedule.updated` (details: changed field names, `enabled`, `allowProtected`,
  `insecureTls` when changed), `schedule.deleted`
- `schedule.secrets_set` (names only)
- `schedule.run_requested` (run now), `schedule.run_cancelled`
- `schedule.run_finished`: `actor: system`, with details `runId`, `status`, `reason?`, `total`,
  `passed`, `failed`, `errored`, `skipped`, `durationMs` and `commit`

Skipped overlap runs are not events. Alert deliveries are not events, but they can be read from the run.

## 4. Data model

`packages/server/migrations/scheduled-runs/0014_scheduled-runs.sql`:

```sql
create table schedules (
  id               text primary key,
  workspace_id     text not null references workspaces (id) on delete cascade,
  name             text not null,
  cron             text not null,
  time_zone        text not null,
  target           jsonb not null,
  options          jsonb not null default '{}'::jsonb,  -- timeoutMinutes, allowProtected, insecureTls, bail
  alerts           jsonb not null default '{"targets":[],"muteAfter":3}'::jsonb,  -- urls sealed, base64
  secrets          jsonb not null default '{}'::jsonb,  -- name -> sealed base64
  enabled          boolean not null default true,
  next_run_at      timestamptz,
  alert_state      text not null default 'ok' check (alert_state in ('ok', 'failing')),
  failure_streak   integer not null default 0,
  created_by       text,
  created_at       timestamptz not null default now(),
  updated_at       timestamptz not null default now(),
  unique (workspace_id, name)
);
create index schedules_due on schedules (next_run_at) where enabled;

create table schedule_runs (
  id            text primary key,
  schedule_id   text not null references schedules (id) on delete cascade,
  trigger       text not null check (trigger in ('schedule', 'manual')),
  status        text not null check (status in ('queued','running','passed','failed','errored','skipped','cancelled')),
  reason        text,
  commit_id     text,
  environment   text,
  queued_at     timestamptz not null default now(),
  started_at    timestamptz,
  finished_at   timestamptz,
  summary       jsonb
);
create index schedule_runs_schedule on schedule_runs (schedule_id, queued_at desc, id desc);
create index schedule_runs_open on schedule_runs (queued_at) where status in ('queued', 'running');

create table schedule_results (
  run_id     text not null references schedule_runs (id) on delete cascade,
  ordinal    integer not null,
  result     jsonb not null,           -- masked JSON-report request entry
  primary key (run_id, ordinal)
);

create table schedule_alert_outbox (
  id            text primary key,
  schedule_id   text not null references schedules (id) on delete cascade,
  run_id        text references schedule_runs (id) on delete cascade,
  target_index  integer not null,
  kind          text not null check (kind in ('failure', 'recovery')),
  payload       jsonb not null,
  state         text not null default 'pending' check (state in ('pending', 'delivered', 'dead')),
  attempts      integer not null default 0,
  next_at       timestamptz not null default now(),
  last_error    text,
  created_at    timestamptz not null default now()
);
create index schedule_alert_outbox_due on schedule_alert_outbox (next_at) where state = 'pending';
```

The migration number is the next free one when the migration lands. `0014` is free on main today.

## 5. Architecture

### 5.1 Engine: `runSuite`

`packages/engine/src/run/suite.ts` moves these from `packages/cli/src/commands/run.ts`, `sequence.ts`
and `ops/environment.ts`:

- environment pick, selection, sequence resolution and `runSequences`;
- data-table planning;
- baseline read;
- secret needs and the masker.

It exposes:

```ts
runSuite(input: {
  projectDir, workspace?, environment?, select?, sequences?, data?, overrides?,
  host: SendHost, secrets: (name) => string | undefined, system: Record<string, string | undefined>,
  signal, timeoutMs?, insecure?, bail?, protectedEnvironments: 'warn' | 'refuse' | 'allow',
}): Promise<SuiteOutcome>  // { result, masker } or a refusal { code, message }
```

The CLI's `runCommand` becomes a caller of `runSuite` and keeps its reporters, flags and exit codes.
The golden *write* path (`--update-baseline`) stays in the CLI. `RunContext` gains an optional
`system`; `scopesFor` and `withSystemValuesReported` use it before `process.env`. The masker and the
JSON report's request-entry shape move to the engine with `runSuite`, because both hosts persist masked
results.

### 5.2 Server module

`packages/server/src/schedules/`:

| File | Purpose |
| --- | --- |
| `cron.ts` | Pure. Parse, presets, next fire in a zone. |
| `repo.ts` | SQL. |
| `seal.ts` | Secrets and URLs, over `secret-box.ts`. |
| `routes.ts` | REST endpoints. |
| `scheduler.ts` | Tick and claim. |
| `executor.ts` | Snapshot → `runSuite` → store. |
| `materialise.ts` | Snapshot to a temporary directory. |
| `alerts/state.ts` | Pure state machine. |
| `alerts/render.ts` | Pure: email text, Slack blocks, Teams card, webhook JSON. |
| `alerts/smtp.ts` | Email delivery. |
| `alerts/https.ts` | HTTPS delivery. |
| `alerts/outbox.ts` | Retrying delivery worker. |
| `sweep.ts` | Retention. |
| `cli.ts` | Admin commands. |
| `module.ts` | Registration. |

The module registers after `live-updates` and before `audit-log` in `BUILTIN_MODULES`, and
`ServerModule['name']` gains `'scheduled-runs'`. Its `CommitStore` is built from `ctx.git`,
`ctx.repos` and the data directory, as the sync module builds its own.

### 5.3 Dependencies

- **Cron:** `croner` (MIT, no dependencies, time-zone aware) for next-fire computation. Our own parser
  validates the five fields first, so the stored text is canonical.
- **SMTP:** `nodemailer` (MIT-0).
- Both go through `pnpm licenses:third-party`.

## 6. Security

- Every route checks the workspace role first and the feature second; a viewer can't write.
- Secrets and alert URLs are sealed at rest and never returned; reads show hints.
- A run's system scope is empty (assumption 4); a test proves a `${#System#…}` reference to a server
  variable expands to nothing.
- Stored results and alert payloads are masked with every sealed value, every `WIREBENCH_SECRET_*` value
  used, and every value the run reported through `onSecretValue`. A test runs a suite that echoes a
  secret and finds it in no row.
- Schedules run requests from inside the operator's network by design. The operator can turn the
  feature off with `WIREBENCH_SERVER_SCHEDULES_ENABLED=false`, which removes the routes and the
  scheduler. The alert-host allow-list bounds where alerts go. `allowProtected` and `insecureTls` are
  audited.
- The temporary directory is private to the server user and removed after each run. A run cannot
  write into the bare repository.
- Audit `details` carry names, counts and the commit, never values.

## 7. Configuration (new variables)

| Variable | Default | Purpose |
| --- | --- | --- |
| `WIREBENCH_SERVER_SCHEDULES_ENABLED` | `true` | Removes routes and scheduler when false. |
| `WIREBENCH_SERVER_SCHEDULES_SECRET_KEY` | — (secret) | 32 bytes base64; seals secrets and alert URLs. |
| `WIREBENCH_SERVER_SCHEDULES_CONCURRENCY` | `2` | 1–16 concurrent runs. |
| `WIREBENCH_SERVER_SCHEDULES_MAX_AGE_DAYS` | `90` | 1–3650. |
| `WIREBENCH_SERVER_SCHEDULES_MAX_SNAPSHOT_MB` | `50` | 1–1024. |
| `WIREBENCH_SERVER_SCHEDULES_ALERT_HOSTS` | — | Allow-list for alert URLs. |
| `WIREBENCH_SERVER_SMTP_URL` | — (secret) | `smtp://` or `smtps://`. |
| `WIREBENCH_SERVER_SMTP_FROM` | — | Sender address. |

They are documented by the generated config tables (`pnpm docs:server-config`).

## 8. Testing strategy

- **Engine:** `runSuite` gets parity tests that reuse the CLI run fixtures. The CLI test suite stays
  green unchanged, which proves the extraction. `system` injection gets its own tests.
- **Cron:** field parsing, presets, `every 7m` refused (it must divide the hour), DST spring-forward and
  fall-back in Europe/Vienna and America/New_York, and next fire after a long downtime.
- **Alert state:** a table test of the state machine, including mute at `muteAfter`, recovery when
  muted, and skipped and cancelled runs ignored.
- **Renderers:** golden outputs for each kind, and masking.
- **Integration (real Postgres, `server-integration` job):**
  - routes with the role matrix and the 403 without a license;
  - claim with `skip locked` across two schedulers;
  - the overlap skip and the concurrency cap;
  - an executor run against a local HTTP fixture server, from a seeded workspace through results;
  - `target-missing` and `environment-protected`;
  - timeout, shutdown cancel, and boot recovery of `running` runs;
  - outbox retry and dead-lettering, against a local HTTPS stub and a stub SMTP sink;
  - retention;
  - every new audit action, to satisfy the coverage test, plus the no-secrets assertion.
- **Timers:** `manualTimers()` throughout; no test sleeps.

## 9. Boundaries

- The module never writes to a workspace repository.
- The module never decrypts team secrets.
- No route returns a secret value or an alert URL.
- The CLI's behaviour and output do not change.

## 10. Success criteria

1. On Enterprise, a workspace admin creates a schedule with `*/5 * * * *` and it runs every five
   minutes against the workspace's latest main, storing each run's results.
2. A failing run sends a failure alert to email, Slack, Teams and webhook targets; the next failures
   alert until `muteAfter`, then stop; the next passing run sends a recovery alert.
3. Runs older than the retention age disappear within ten minutes of the boundary.
4. Schedule changes and every finished run appear in the audit log, with no secret in any row.
5. Without the feature, every route answers 403 and nothing fires; installing a license resumes.
6. `wirebench run` behaves exactly as before.
7. The editions table on the docs site lists scheduled runs under Enterprise; a docs-site page covers
   setup, cron, secrets, alerts, retention and the egress settings.
8. `pnpm check` green; the server-integration job green.

## 11. Delivery

Four implementation pull requests after this design's:

1. engine `runSuite` and system-scope injection;
2. schedules module core: migration, config, cron, CRUD, secrets, audit;
3. scheduler, executor, results, retention, run now, live message, admin CLI;
4. alerts and docs.

Each PR is green on its own.

## 12. Risks

- **The extraction regresses the CLI.** Mitigation: it is its own PR, and the existing CLI tests are
  the oracle.
- **Snapshot size and disk churn** on large workspaces every minute. Mitigation: the size cap, and only
  the target project's directory, `workspace.yaml` and `environments/` are written.
- **Alert storms** across many schedules during an outage. Mitigation: muting per schedule, the outbox
  with backoff, no retries beyond 8.
- **An admin points a schedule at an internal service the operator did not expect.** This is
  inherent to the feature. Mitigation: Enterprise-only, the operator off-switch, and the audit trail.

## 13. Follow-ups

- #517 Desktop Schedules tab with run history and the live `schedule-run` message, designed mockup first.
- #518 Workspace secret sources on the server, behind an operator trust setting.
- #519 Latency trend alerts.

## 14. Revisions after building

Rulings made while building, which supersede the sections above where they differ.

- **Secrets come from the schedule only (§3.2, §3.3).** A run resolves a secret from the schedule's
  sealed values, by the name `WIREBENCH_SECRET_<NAME>` gives it in a pipeline. The server's own
  `WIREBENCH_SECRET_*` environment is never read: it belongs to the operator, not to a workspace.
- **An unset `${#System#…}` errors the request (§6).** The system scope is empty, as planned, but the
  engine treats an unresolved reference as `rest-unresolved-properties`, so the request errors rather
  than sending an empty value. The test proves the server's variable never reaches the wire.
- **The target names a project by slug or id (§2).** Slugs keep case and spaces (`CountryInfo`), so the
  target takes any non-empty name up to 200 characters. A linked project errors with `target-invalid`.
- **Interrupted runs are found by deadline, not at boot (§3.1).** Servers may share a database, so a
  booting server cannot tell its own crashed runs from another server's live ones. Each pass ends a
  run still `running` a minute past its schedule's deadline as `errored` with reason `interrupted`, and
  that run counts as errored for the alert state.
- **Callback assertions are unavailable in scheduled runs.** A callback assertion errors with a
  message saying so, until a run can read the workspace's catch URLs.
- **Alerts are evaluated in the run's transaction (§3.2 step 5).** The alert state and the queued
  deliveries commit with the run's outcome, before the announcement, so a crash cannot store one
  without the other.
- **The outbox leases rather than locks (§3.4).** A pass marks up to 20 due deliveries taken for a minute
  and sends them outside a transaction, so no row lock is held across a 10 s send. A delivery looks its
  target up by index when it is sent: a target removed since then gets nothing, and the delivery is
  retried until it is given up.
- **A run's deliveries are part of its detail.** `GET …/runs/:runId` returns `alerts`: kind, target
  index, state, attempts and last error, never the payload or the URL. This is how "they can be read
  from the run" (§3.9) is met.
- **A test alert touches nothing.** `POST …/alerts/test` sends synchronously, outside the outbox, and
  changes neither the alert state nor the history.
- **Alert size.** A failing request's message is cut to 300 characters, and a Slack header to the 150
  Slack accepts.
- **Delivery (§11).** PR 1 (#509) merged into this design's branch rather than main, so #514 carried its
  commits to main along with PR 2.
