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
- **`desktop.run_finished`**, one per test-suite run that ends, including cancelled ones.
  - Details: `sequenceId`, `name`, `outcome`, `passed`, `failed`, `errored`, `skipped`, `durationMs`,
    `hosts` (distinct origins the steps reached, at most 64), `environment`, `startedAt`, `sentAt`.
- Target: `{ kind: 'workspace', id }`, with `workspaceId` and `teamId` set. Actor: the signed-in user
  who reports, from the token, never from the body. `at` is the server's receipt time; `sentAt` keeps
  the desktop's time.

### 2.3 Masking the URL

The URL is the one actually sent, after variables. Before it leaves the send path the desktop:

1. Applies `redactUrl(url, { show: false })`: the URL's password and the values of sensitive query
   parameters become `<redacted>`, whatever the app's show-secrets toggle says.
2. Applies the session secret masker (`redactSecretValues`), so any resolved credential that appears
   in a path or another query value is masked too.
3. Cuts the result at 2048 characters.

### 2.4 Delivery

- Each event is written first to an outbox in the workspace's folder (`server/audit-outbox/`, one
  JSON file per event, written atomically), then sent in batches of at most 100 to
  `POST /api/v1/workspaces/:id/audit/desktop-events`.
- The reporter sends shortly after an event is queued, after each successful sync fetch, and after
  sign-in. On a network failure it backs off (from 5 s doubling to 5 min) and keeps the files.
  Signed out, it keeps the files until sign-in.
- The outbox holds at most 5000 events. Past that the oldest are dropped and their count travels with
  the next batch as `dropped`; the server records `desktop.events_dropped` with `{ count }`, so a gap
  in the trail is itself on the record.
- The server answers `409 audit-desktop-recording-off` when the workspace no longer records. The
  desktop then deletes its outbox for that workspace and stops recording until a fetch says otherwise.
- A desktop never decides the actor, the time or the workspace's team; the server does.

### 2.5 The route

`POST /api/v1/workspaces/:workspaceId/audit/desktop-events`, body
`{ events: DesktopAuditEvent[] (0–100), dropped?: integer ≥ 1 }`, at least one of the two present.

- Signed-in users only, with any role on the workspace (`requireWorkspaceRole(db, 'viewer')`). A CI
  token is refused with 403: the command line does not report.
- Every edition records, as for the server's own events.
- A batch is written in one transaction. The answer is `204`.
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
