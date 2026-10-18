# Team session logs and live terminal sharing — plan

**Spec:** `docs/specs/2026-10-17-team-session-logs-and-sharing-design.md` · **Issues:** #430, #429 ·
**Date:** 2026-10-17

Three pull requests: this spec and plan; #430 (tasks 1–7); #429 (tasks 8–14, branched from #430's head
because it shares the engine feature list and the audit registry). One commit per task, each after
`WIREBENCH_SKIP_PERF=1 pnpm check` is green. Server integration tests need the test database
(`docker compose -f packages/server/compose.yaml up -d db`, `WIREBENCH_SERVER_TEST_DATABASE_URL` on port
55432 on this machine).

## #430 — team session logs

1. **Engine contracts.** Add `session-logs` and `terminal-sharing` to `FEATURES`
   (`server-api/licensing.ts`). Add the `session_log.*`, `terminal_share.*` and
   `workspace.session_logs_changed` actions, their groups and the `session_log` / `terminal_share` target
   kinds (`server-api/audit.ts`). New `server-api/session-logs.ts`: open, chunk, end, list, read schemas and
   the problem codes. `recordSessionLogs` on the team workspace answer, the workspace patch and the sync
   head. Unit tests for the schemas.
2. **Server: module, migration, writes.** `migrations/session-logs/0016_session-logs.sql`; module
   `session-logs` in `BUILTIN_MODULES` after `auditLog`, capability `session-logs`; `repo.ts`; routes
   `POST /`, `POST /:logId/chunks`, `POST /:logId/end`; `WIREBENCH_SERVER_SESSION_LOG_MAX_MB` in config;
   the teams workspace patch takes `recordSessionLogs` (feature-gated when turning on, audited, announces
   `accessChanged`); the sync head echoes it. Integration tests: switch off → 409, feature missing → 403,
   idempotent open, offset resync, size cap, only the uploader writes, CI token refused, non-member 404.
3. **Server: reads, delete, retention.** `GET /`, `GET /:logId/text` (audited), `DELETE /:logId`
   (workspace admin, audited); age sweeper on `last_write_at` against `auditMaxAgeDays`, stopped on close.
   Integration tests: list filters, read across chunks with offset, audit rows, delete by admin only,
   sweep deletes old logs only.
4. **Desktop: target and forced recording.** `ServerClient` session-log methods;
   `WorkspaceService.sessionLogTarget()` fed by the head; `sessionLogPlanner` records when the target
   records; the `sessionLog.switches` answer says when the team records so the host menu and host details
   show "Recorded by your team" disabled. Unit tests.
5. **Desktop: uploader.** `main/session-log-uploader.ts`: `<id>.upload.json`, open, debounced 512 KB
   chunks from the append-only `.log`, end, back-off, 409 resync, permanent stops, resume and `lost` ending
   on start; wired to the store's start/push/end and to sign-in. Unit tests with a fake client and clock.
6. **Desktop: viewer and admin switch.** IPC `teamSessionLog.list` / `teamSessionLog.read`; the Team session
   logs dialog (host and member filters, live dot, Refresh, read-only viewer), palette `ssh.teamSessionLogs`,
   SSH menu item and a Team logs link in host details; **Record SSH sessions** in the team Workspaces tab
   behind the `session-logs` capability. Renderer tests.
7. **e2e, docs, CHANGELOG.** Fake server: switch, open/chunk/end/list/text. e2e: admin turns recording on,
   a session's output reaches the team dialog. Docs: `guides/hosts-and-terminals.mdx` (Team session logs),
   `guides/server-audit-log.mdx` (new events), server configuration reference
   (`WIREBENCH_SERVER_SESSION_LOG_MAX_MB`). CHANGELOG `[Unreleased] › Added`.

## #429 — live terminal sharing

8. **Engine protocol.** `server-api/terminal-share.ts`: create/info schemas, client and server socket
   messages, limits (4 KB frames, 256 KB replay, 20 viewers, 64 inputs/s), close codes 4403/4410. Tests.
9. **Server: share registry.** `terminal-shares/registry.ts`, pure and clock-injected: create, attach
   owner/viewer, request, grant, decline, take-back, release, remove (and refuse rejoin), end, replay ring
   buffer, access recheck, presence lists. Unit tests for every rule in spec B1.
10. **Server: module, routes and socket.** Module `terminal-shares` after `live`, capability
    `terminal-sharing`; `POST` and `GET` routes; the socket route with auth, owner/viewer, frame relay,
    heartbeat, input rate cap; listeners on `accessChanged` and `sessionEnded`; audit rows. Socket tests
    with a real `ws` client against the harness.
11. **Desktop: owner service.** `main/terminal-share/owner.ts`: create, socket, output tap after the
    masker in `SshService` (4 KB frames), holder input written to the session, presence and requests
    emitted to the owning window, stop on tab/session close. IPC `terminalShare.start/stop/grant/decline/
    takeBack/remove`, event `terminalShare.state`. Unit tests.
12. **Desktop: viewer client.** `main/terminal-share/viewer.ts`: parse the link, check the account for
    that server, info call, socket, `terminalShare.join/leave/input/requestControl/release`, events
    `terminalShare.viewerData` / `terminalShare.viewerState`. Unit tests.
13. **Renderer.** **Share session…** in the terminal menu; the share strip (presence, control holder,
    Copy invite link, Approve/Decline, Take back, Stop, remove a viewer); **Join shared terminal…** dialog
    (palette and SSH menu); the `terminal-share` tab kind with a read-only xterm, header, presence and
    Request/Release control. Renderer tests.
14. **e2e, docs, CHANGELOG.** Fake server relay; e2e with two app instances (start, join by link, see
    output, request, approve, type, stop). Docs: `guides/hosts-and-terminals.mdx` (Share a live session),
    `guides/server-audit-log.mdx`. CHANGELOG `[Unreleased] › Added`.

## Follow-ups to file

- Register `wirebench://` with the OS so an invite link opens the app.
- Share local, Telnet and Serial terminals.
