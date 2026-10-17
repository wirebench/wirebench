# Team session logs and live terminal sharing — design

**Issues:** #430 (team session logs on the server), #429 (share a live session with teammates) · **Date:**
2026-10-17 · **Status:** owner rulings taken in session 2026-10-17

Builds on: the SSH session logs design (`docs/specs/2026-10-13-ssh-session-logs-design.md`, #414, whose
sidecar records the bound server for this issue), the live-updates design
(`docs/specs/2026-09-26-wirebench-server-live-updates-design.md`), the audit log, licensing and desktop audit
events designs (`2026-10-01-wirebench-server-audit-log-design.md`, `2026-10-01-wirebench-server-licensing-design.md`,
`2026-10-03-wirebench-desktop-audit-events-design.md`) and the teams-access roles.

## Objective

A team whose hosts live in a server-bound workspace can:

1. **Read what a teammate's SSH session printed** (#430). A team admin turns recording on for a workspace;
   every SSH session on its hosts then streams its masked text log to the server while it runs. Workspace
   members read the logs per host and per member, nobody can edit them, every read is audited, and the
   server drops them at the audit retention age.
2. **Watch, and with permission drive, a teammate's live terminal** (#429). The owner of an open SSH
   terminal shares it; teammates who open the invite link watch the same masked screen; a viewer may ask
   for control and the owner approves; the owner can take control back, remove a viewer or stop at any
   time, and closing the tab ends the share. The server relays in memory and stores nothing but audit rows.

## Rulings

| #   | Question                                   | Ruling                                                                                                                                                                                                                                                                                      |
| --- | ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Edition                                    | Both are Enterprise. Two new license features, `session-logs` and `terminal-sharing`; an Enterprise license without an explicit feature list grants them, as it grants every feature.                                                                                                     |
| R2  | Who turns team logs on                     | A per-workspace switch, **Record SSH sessions**, that a workspace admin (a team admin passes) sets, like **Record desktop activity**. Turning it on needs the `session-logs` feature.                                                                                                       |
| R3  | Does the switch override the local opt-in? | Yes. While it is on, every SSH session on that workspace's hosts is logged on the member's machine and streamed, whatever the local **Log sessions** switches say; the recording mark shows and the member cannot turn it off for that workspace.                                          |
| R4  | When does a log reach the server?          | While the session runs: the desktop streams the text log in chunks a few seconds behind the screen, so teammates can read a session that is still open. A crash or lost network resumes from the server's byte count on the next start.                                                    |
| R5  | What is uploaded?                          | The text log only (`<id>.log`, already masked by #414 R5/R6), never the raw stream, never input. Its sidecar fields travel as the log's metadata.                                                                                                                                          |
| R6  | Who reads                                  | Every member with access to the workspace (viewer and up) lists and reads all its logs, filtered by host and by member. Nobody edits a log. Each content read is one `session_log.read` audit row.                                                                                       |
| R7  | Retention and deletion                     | A log is deleted once its last write is older than the audit max age (`WIREBENCH_SERVER_AUDIT_MAX_AGE_DAYS`, default 365). A workspace admin may delete one earlier; that is audited.                                                                                                     |
| R8  | Viewer rights in a share                   | View-only. The owner can always type.                                                                                                                                                                                                                                                       |
| R9  | Control handover                           | A viewer asks (**Request control**); the owner approves or declines. At most one viewer holds control at a time; the owner takes it back in one click, the holder can hand it back.                                                                                                     |
| R10 | Secrets in a share                         | Viewers receive exactly what the owner's screen receives, after the screen masker. The server relays it in memory only and writes nothing about a share but audit rows. Keystrokes are never relayed to viewers; a viewer in control types into the owner's session, and only the echo is seen. |
| R11 | Joining                                    | By invite link, which only members with access to the workspace can open. Open shares are not listed anywhere.                                                                                                                                                                             |
| R12 | Late joiners                               | The server keeps the last 256 KB of masked output of each share in memory and replays it on join.                                                                                                                                                                                          |

## Part A — team session logs (#430)

### A1. Server module `session-logs`

A new `ServerModule` (`packages/server/src/session-logs/`), registered after `auditLog`. Capability
`session-logs` in `/meta`. Migration `0016` (`migrations/session-logs/0016_session-logs.sql`):

```sql
alter table workspaces add column record_session_logs boolean not null default false;

create table session_logs (
  id            text primary key,            -- ULID minted by the server
  workspace_id  text not null references workspaces(id) on delete cascade,
  user_id       text not null references users(id) on delete cascade,
  client_log_id text not null,               -- the #414 id, 20261013T183000Z-6f1c2d3e
  host_id       text not null,
  host_name     text not null,
  address       text not null,
  port          integer not null,
  ssh_user      text not null,
  started_at    timestamptz not null,
  ended_at      timestamptz,
  exit_code     integer,
  signal        text,
  reason        text,                        -- exit | lost | closed
  size_bytes    bigint not null default 0,
  truncated     boolean not null default false,
  last_write_at timestamptz not null,
  unique (workspace_id, user_id, client_log_id)
);
create index session_logs_workspace_started on session_logs (workspace_id, started_at desc);
create index session_logs_last_write on session_logs (last_write_at);

create table session_log_chunks (
  log_id       text not null references session_logs(id) on delete cascade,
  offset_bytes bigint not null,
  data         bytea not null,
  primary key (log_id, offset_bytes)
);
```

Routes, all under `/api/v1/workspaces/:workspaceId/session-logs`. Each is guarded by
`requireWorkspaceRole(db, 'viewer')`, refuses a CI token (`request.caller` must be set), then
`requireFeature('session-logs')`:

| Route                      | Who               | What                                                                                                                                                                                                                                                                                       |
| -------------------------- | ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `POST /`                   | any member        | Opens a log: `{clientLogId, hostId, hostName, address, port, user, startedAt}`. 409 `session-logs-recording-off` unless the switch is on. Idempotent on `(workspace, caller, clientLogId)`: a repeat answers 200 with the existing `{id, size}`. Audited `session_log.started`.            |
| `POST /:logId/chunks`      | the uploader only | `{offset, data}` (base64, ≤ 512 KB decoded). `offset` must equal the stored size, else 409 `session-logs-offset`; the client reopens the log to learn the stored size. Answers `{size, truncated}`; past `WIREBENCH_SERVER_SESSION_LOG_MAX_MB` (default 64) the log is marked `truncated` and further bytes are dropped. Not audited. |
| `POST /:logId/end`         | the uploader only | `{endedAt, exitCode?, signal?, reason}`. Once ended, chunks are refused (409 `session-logs-ended`).                                                                                                                                                                                        |
| `GET /`                    | any member        | Metadata only, newest first, `?hostId=&userId=&before=&limit=` (limit ≤ 200). Each row names the member (`userId`, display name) and whether it is still live. Not audited (no content).                                                                                                  |
| `GET /:logId/text?offset=` | any member        | The text from `offset` (default 0), at most 4 MB per answer, with `size`, `truncated` and `live`. Audited `session_log.read` with `{offset, bytes}`.                                                                                                                                       |
| `DELETE /:logId`           | workspace admin   | Deletes the log and its chunks. Audited `session_log.deleted`. A live log's next chunk then gets 404 and the desktop stops uploading it.                                                                                                                                                   |

The switch rides on the existing workspace patch: `PATCH /workspaces/:workspaceId` takes
`recordSessionLogs` (turning it on needs the `session-logs` feature, else 403 `licensing-feature-required`),
records `workspace.session_logs_changed {enabled, previous}` and announces `accessChanged`. The team
workspace answer and the sync head carry `recordSessionLogs`, as they carry `recordDesktopActivity`, so a
desktop learns the switch on its next head fetch or live `access` message.

**Retention** reuses the audit module's `CaptureSweeper` pattern: at start and every ten minutes, delete
logs whose `last_write_at` is older than `auditMaxAgeDays`, in batches of 1000. Deleting a log by age is
not audited, the same as audit rows ageing out.

### A2. Desktop

- **Target.** `WorkspaceService` gains `sessionLogTarget()` → `{url, workspaceId, record}` for a
  server-bound workspace, fed by the head fetch (`recordSessionLogs`) next to `auditTarget()`.
- **Forced recording (R3).** `sessionLogPlanner` logs a session when the local switch is on **or** the
  target's `record` is true. The host menu's **Log sessions** item and the host details' log switch show
  "Recorded by your team" and are disabled while the target records. The red recording mark is unchanged.
- **Streaming (R4).** A `SessionLogUploader` in main, one per machine. When a log starts under a recording
  target it writes `<id>.upload.json` next to the log (`{url, workspaceId, serverLogId?, sent, ended}`),
  opens the server log, then sends what the append-only `<id>.log` holds past `sent` in chunks of up to
  512 KB, two seconds after the last write (debounced) and at the end, followed by `end`. Failures back off
  5 s → 300 s. A 409 offset answer reopens the log, whose answer moves `sent` to the server's size. On start the uploader resumes every
  `upload.json` not marked done: a log with no `endedAt` in its sidecar (the app crashed) is ended with
  `reason: lost`. A 403/404 for the workspace, a 409 recording-off or a deleted log stop that log's upload
  for good and say so in the main log. The local size cap (#414 R3) still applies; a pruned log stops
  uploading.
- **Viewer.** A **Team session logs** dialog (SSH menu, palette `ssh.teamSessionLogs`, and a **Team logs**
  link in the host details' Session logs section of a server-bound workspace) lists the workspace's logs
  with host and member filters and a live dot, and opens one read-only in the same viewer as local logs,
  with **Refresh** for a live log. The dialog shows only when `/meta` has `session-logs`.
- **Admin switch.** The team dialog's Workspaces tab shows **Record SSH sessions** under **Record desktop
  activity** for admins when `/meta` has `session-logs`; others see "SSH sessions are recorded".

## Part B — live terminal sharing (#429)

### B1. Server module `terminal-shares`

A new `ServerModule` registered after `live` (its socket route needs `@fastify/websocket`, which wraps only
routes registered after the live module). Capability `terminal-sharing`. No migration: shares live in
memory (`ShareRegistry`), and a server restart ends them all.

- `POST /api/v1/workspaces/:workspaceId/terminal-shares` `{hostName, cols, rows}`, guarded by viewer role,
  no CI token and `requireFeature('terminal-sharing')`, answers `{shareId}` (a 128-bit random id, base32).
  Audited `terminal_share.started`. The owner must open the socket within 30 s or the share is dropped.
- `GET /api/v1/workspaces/:workspaceId/terminal-shares/:shareId` answers `{hostName, ownerName, viewers}`
  for the join dialog, or 404 for a share that does not exist, belongs to another workspace, or removed the
  caller.
- `GET /api/v1/terminal-shares/socket` is a WebSocket using the live origin check and the same 4 KB client
  message cap. The first message is `{type:'auth', token, workspaceId, shareId}`. The server checks the
  token (`callerForToken`), the feature, the caller's role in the workspace (≥ viewer) and the share; the
  share's creator becomes its **owner** (one owner socket, a second is refused), anyone else a **viewer**.
  A share takes at most 20 viewers.

**Protocol** (`packages/engine/src/server-api/terminal-share.ts`, zod, shared with the desktop):

- Owner → server: binary frames of masked output (≤ 4 KB each); text `resize {cols, rows}`,
  `grant {userId}`, `decline {userId}`, `take-back`, `remove {userId}`, `end`, `ping`.
- Viewer → server: text `request-control`, `release`, `input {data}` (base64, only while holding control,
  else ignored), `ping`.
- Server → owner: `ready {role:'owner'}`, `presence {viewers:[{userId, name, control, requesting}]}`,
  `input {data, userId}` (from the holder), `pong`.
- Server → viewer: `ready {role:'viewer', hostName, ownerName, cols, rows}`, then one binary frame with the
  replay buffer (R12), then binary output frames as they come; `presence` (the same list, plus the owner),
  `resize`, `control {userId | null}`, `declined`, `ended {reason}` and close, `pong`.

**Rules.** `grant` needs a pending request from that viewer and moves control there (a previous holder
loses it). `take-back`, `release`, the holder leaving or being removed sets control to nobody.
`remove` closes that viewer's socket and keeps them out of this share. The owner socket closing, `end`, or
the owner's token ending ends the share for everyone (`ended {reason: 'owner-left' | 'ended' | 'revoked'}`).
When a viewer loses access to the workspace (the module listens on the `accessChanged` and
`sessionEnded` announcements, as the live hub does), their socket closes with `ended {reason: 'access'}`.
Sockets are pinged every 30 s and dropped after a missed pong. A viewer's input is capped at 64 messages a
second.

**Audit** (each in its own transaction): `terminal_share.started`, `terminal_share.joined` (every join),
`terminal_share.control_granted {userId}`, `terminal_share.control_returned {userId, by}`,
`terminal_share.viewer_removed {userId}`, `terminal_share.ended {reason, viewers}`. Target kind
`terminal_share`, id the share id, `details.hostName`. No output, no input, ever.

### B2. Desktop

- **Owner.** The terminal's context menu gets **Share session…** (only in a server-bound workspace whose
  server advertises `terminal-sharing`). `TerminalShareService` in main creates the share, opens the socket
  and taps the session's output **after the screen masker** (the same point the session log is fed), cut
  into 4 KB frames. Input arriving from the holder is written to the session as if typed. A share strip on
  the pane shows the viewer count and names (presence), who holds control, **Copy invite link**, an
  Approve/Decline prompt for each request, **Take back control** and **Stop sharing**; removing a viewer is
  in the presence list's menu. Closing the tab or the session stops the share.
- **Invite link.** `wirebench://terminal-share/<shareId>?server=<url>&workspace=<workspaceId>`. This slice
  does not register a URL handler: the link is pasted into **Join shared terminal…** (SSH menu and palette).
  Registering `wirebench://` with the OS is a follow-up.
- **Viewer.** Joining opens a `terminal-share` tab: a read-only xterm sized to the owner's terminal, a
  header with host, owner and the presence list, and **Request control** / **Release control**. While the
  viewer holds control, keystrokes go out as `input`. When the share ends, the tab says why and stays
  readable until closed.
- **Masking.** The viewer gets nothing the owner's screen did not, so a snippet secret, an environment
  secret and a connect secret are masked for viewers exactly as for the owner.

## Errors

New problem codes: `session-logs-recording-off` (409), `session-logs-offset` (409; reopen to learn the size),
`session-logs-ended` (409), `session-logs-not-found` (404), `terminal-share-not-found` (404),
`terminal-share-full` (409). Socket close codes reuse `LIVE_CLOSE` where they mean the same, plus 4403
(not allowed: removed, no feature, no access) and 4410 (share ended).

## Testing

- Server integration (real Postgres): switch and feature gate; idempotent open; offset resync; size cap;
  uploader-only writes; viewer reads and audit rows; admin-only delete; retention sweep by age; CI token
  refused; a non-member gets 404.
- Server unit: share registry rules (grant without request, one holder, take-back, release, remove and
  rejoin refused, owner leaving ends the share, replay buffer bound at 256 KB, input ignored without
  control); the socket with a real `ws` client (auth order, owner vs viewer, access loss closes, audit rows).
- Desktop unit: planner forcing, uploader (chunking, debounce, resume after crash, 409 resync, stop on
  403/404), share service (tap after masker, input routing, stop on tab close).
- e2e (headless, against the fake server): admin switch shows, a session streams its log and the team
  dialog reads it; a share is started, a second app instance joins by link, sees output, requests control,
  is approved and types.

## Non-goals

- Registering `wirebench://` with the operating system (follow-up).
- Sharing a local terminal, Telnet or Serial session (SSH only in this slice).
- Recording a share's viewers' views separately (the owner's session log already holds the output).
- Searching team logs on the server (the viewer searches the text it fetched).
- Running more than one server process: shares and their sockets live in one process's memory.
