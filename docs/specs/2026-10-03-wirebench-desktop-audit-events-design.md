# Wirebench: desktop events in the server audit log — design

Date: 2026-10-03 · Status: decisions by the owner in conversation 2026-10-03 · Issue: #211 · Module:
`audit-log` (second slice), with a setting in `teams-access`

- Builds on `docs/specs/2026-10-01-wirebench-server-audit-log-design.md`, which left desktop-side
  events out of the first slice (§1.2) because they need a client reporting path and a privacy ruling.
  This note is both.
- Decisions recorded here (owner, 2026-10-03):
  - **What:** each request sent and each test-suite run, from workspaces synced to a team server.
  - **Who turns it on:** a workspace admin, per workspace. Off by default.
  - **How much:** the full URL, with secret-like query values and credentials masked. No headers, no
    bodies.

## 1. Objective

A team that must show what was sent where, for example to a production host, turns recording on for
that workspace. From then on every person's desktop reports each send and each test-suite run in that
workspace to the team server, and the events appear in the audit log beside the server's own.

### 1.1 In scope

- A workspace setting, *Record desktop activity*, changed by a workspace admin and itself audited.
- Three actions in a new group `desktop`: `desktop.request_sent`, `desktop.run_finished` and
  `desktop.events_dropped`.
- A reporting route on the server, and a durable outbox on the desktop that survives being offline,
  signed out or restarted.
- A notice in the app while the open workspace records, so nobody is recorded without knowing.

### 1.2 Not in scope

- Load runs: the app has none (the roadmap defers load testing). "Runs" means test-suite runs.
- Local workspaces, folder or Git shares, and ad-hoc sends outside a project: no team server to report to.
- Requests made by the command line or the MCP server.
- Headers, bodies, responses, and anything a request carries besides its URL.

## 2. Behaviour

### 2.1 The setting

- `workspaces.record_desktop_activity boolean not null default false` (migration 0009 in
  `teams-access`). `PATCH /workspaces/:id` accepts `recordDesktopActivity: boolean` from a workspace
  admin. A change records `workspace.desktop_recording_changed` with `{ enabled, previous }` in the
  same transaction and announces `accessChanged`, so connected desktops fetch again.
- `TeamWorkspace` carries `recordDesktopActivity`. The sync head response carries it too, so a desktop
  learns a change on its next fetch without another request (the head is already polled).
- The server lists the `desktop-activity` capability in `GET /api/v1/meta`. The *Record desktop
  activity* switch and the "Desktop activity is recorded" note are shown only on a server that lists
  it, so an older server never offers a setting it would ignore.

### 2.2 What a desktop reports

The desktop records only while the open workspace is shared to a server and its last fetched head
said `recordDesktopActivity: true`.

- **`desktop.request_sent`**, one per send from the editor, History, the HTTP log or a
  multi-environment send, successful or failed. Sends that are steps of a test-suite run are not
  reported one by one; the run's event covers them.
  - Details: `protocol` (`rest`, `soap`, `grpc`, `websocket`), `method` (HTTP method, gRPC
    `service/method`, or `null`), `url` (masked, see 2.3), `status` (HTTP status, gRPC code, or
    `null`), `outcome` (`ok` or `failed`), `durationMs`, `environment` (name or `null`),
    `requestId`, `requestName`, `sentAt` (the desktop's clock, ISO 8601).
- **`desktop.run_finished`**, one per test-suite run that ends, including cancelled ones and runs
  that break off (reported as `errored`, or `cancelled` when the person had stopped the run, with the steps reached).
  - Details: `sequenceId`, `sequenceName`, `outcome`, `passed`, `failed`, `errored`, `skipped`, `durationMs`,
    `hosts` (distinct origins the steps reached, at most 64), `environment` (as it was when the run
    started), `startedAt`, `sentAt`. The suite's name is `sequenceName`, never `name`: the Audit tab
    reads a `name` only from a `workspace.*` action, as the workspace's.
- Target: `{ kind: 'workspace', id }`, with `workspaceId` and `teamId` set. Actor: the signed-in user
  who reports, from the token, never from the body. `at` is the server's receipt time; `sentAt` keeps
  the desktop's time.

### 2.3 Masking the URL

The URL is the one actually sent, after variables. For a REST send that failed, that includes the auth query parameters applied, as for a successful one. Before it leaves the send path the desktop:

1. Applies the session secret masker (`redactSecretValues`), so any resolved credential that appears
   in a path or a query value is masked before `redactUrl` re-encodes the URL (which could hide it from
   the masker).
2. Applies `redactUrl(url, { show: false })`: the URL's password and the values of sensitive query
   parameters become `<redacted>`, whatever the app's show-secrets toggle says. A URL that `new URL`
   cannot parse is masked by text instead: the value of each sensitive query parameter, and a userinfo
   password (`//user:pass@` becomes `//user:<redacted>@`).
3. Applies the session secret masker again.
4. Cuts the result at 2048 characters, before a redaction marker the cut would split.

### 2.4 Delivery

- Each event is written first to an outbox in the workspace's folder (`server/audit-outbox/`, one
  JSON file per event, written atomically), then sent in batches of at most 100 to
  `POST /api/v1/workspaces/:id/audit/desktop-events`.
- An event belongs to the workspace open when its send or run started; the reporter refuses one for
  any other workspace, so a run that ends after its workspace closed is not credited to the next.
- An event recorded before the account list has loaded waits for it, so it is not counted as dropped
  at startup.
- Each outbox entry is stamped with its owner: the user id of the account the desktop has on that
  server (the last one known while signed out). With no account ever known, the event is only counted
  as dropped. A drain sends only the signed-in account's own entries and drops and counts the others,
  so events queued by one person never go out as another who signs in later. The stamp stays in the
  outbox; the batch on the wire is unchanged.
- The reporter sends shortly after an event is queued, after each successful sync fetch, and after
  sign-in. A fetch sends at once, but does not cut a back-off short. On a network failure it backs off
  (from 5 s doubling to 5 min) and keeps the files. Signed out, it keeps the files until sign-in.
- The outbox holds at most 5000 events. Past that the oldest are dropped and their count travels with
  the next batch as `dropped`, at most 1,000,000 in one batch and the rest in the next, so nothing is
  discarded; the server records `desktop.events_dropped` with `{ count }`, so a gap
  in the trail is itself on the record.
- The server answers `409 audit-desktop-recording-off` when the workspace no longer records, and
  `403` or `404` when the workspace is closed to the person. The desktop then deletes its outbox for
  that workspace. A `409` stop ends when a fetch says the workspace records; a `403` or `404` stop
  lasts until the person's role in the workspace changes, or another workspace or server is opened.
- A `400` means the batch can never be accepted: the desktop drops it and counts its events as
  dropped. A `429` (the route's rate limit) is a back-off like a network failure, the files kept; when its
  `Retry-After` (seconds or an HTTP date) is longer than the back-off the retry waits that long,
  capped at 5 min like the back-off.
- Delivery is at least once: a batch the server wrote but whose answer was lost is sent again, so an
  event can appear twice.
- A desktop never decides the actor, the time or the workspace's team; the server does.

### 2.5 The route

`POST /api/v1/workspaces/:workspaceId/audit/desktop-events`, body
`{ events: DesktopAuditEvent[] (0–100), dropped?: integer 1–1,000,000 }`, at least one of the two present.

- Signed-in users only, with any role on the workspace (`requireWorkspaceRole(db, 'viewer')`). A CI
  token is refused with 403: the command line does not report.
- Every edition records, as for the server's own events.
- A batch is written in one transaction. The answer is `204`.
- Each signed-in user has a bucket of 120 batches, refilled at 60 a minute (a desktop sends about one
  per 2 s debounce and catches up in bursts). Past it the answer is `429 audit-desktop-rate-limited`
  with `Retry-After`.
- `dropped` is at most 1,000,000.
- Each event's details are validated against its action's schema and bounded at 4 KiB like any other.

### 2.6 The notice

While the open workspace records, the status bar shows *Recorded* with a tooltip: "Requests and test
runs in this workspace are recorded in the team server's audit log." The Workspaces tab shows the
switch to admins and the state to everyone.

## 3. Security and privacy

- No headers, bodies or responses are reported. The URL is masked twice before it is written to disk.
- The outbox lives in the workspace folder, beside the sync state.
- A user cannot report as someone else, into a workspace they cannot see, or with a server time.
- Turning recording off stops it at once on the server and on the next fetch on each desktop.

## 4. Testing

- Engine: schema tests for the new actions and the ingest body.
- Server: the setting's PATCH and its event, the head flag, the route's refusals (off, CI token, no
  role, bad body), batching, `dropped`, and the coverage test naming every new action.
- Desktop main: the outbox (order, cap, atomic files, restart), the reporter (backoff, signed out,
  409 clears), the send and run hooks, URL masking.
- Renderer: the switch, the status-bar notice, labels for the new actions.
- e2e: none in this slice; the fake server gains nothing. The unit and integration suites cover the
  path end to end on each side of the wire.

## 5. Revisions after review

- Queued events carry their owner's user id in the outbox and are sent only by that account; others
  are dropped and counted (§2.4).
- An event belongs to the workspace open when its send or run started (§2.4); a run that breaks off is
  reported as `errored` (§2.2).
- The run's suite name is `sequenceName` (§2.2), and the Audit tab names a workspace from a
  `workspace.*` action only.
- The route has a per-user rate limit and `dropped` an upper bound (§2.5).
- §2.3 states the masking order and the fallback for a URL that does not parse; §2.4 states how 400,
  403, 404 and 429 are handled, and that delivery is at least once.

### 2026-10-03, from #213

- A `403` or `404` stop lasts until the role changes, not until the next fetch (§2.4); a `429` is
  retried after its `Retry-After` when that is longer than the back-off; a fetch no longer cuts a
  back-off short.
- `dropped` travels at most 1,000,000 to a batch, the rest in the next (§2.4).
- An event recorded before the account list has loaded waits for it (§2.4).
- A run that breaks off after it was cancelled is reported as `cancelled` (§2.2); a failed REST send
  reports its URL with the auth query parameters applied, masked, like a successful one (§2.3).
- The setting's switch needs the `desktop-activity` capability from `GET /meta` (§2.1).
