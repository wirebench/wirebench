# SSH session logs — design

**Issue:** #414 · **Date:** 2026-10-13 · **Status:** owner rulings taken in session 2026-10-13

Builds on: the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, its non-goal on logging output and
amendment A1), the snippets design (`docs/specs/2026-10-12-ssh-snippets-design.md`, the stream masker), and
coordinates with #355 (`desktop.ssh_session` audit) and #430 (team session logs on the server, which uploads
what this writes).

## Objective

A user can look back at what an SSH session printed after its tab is closed. Logging is opt-in per host or
group, kept on this machine, bounded in size, and never holds a credential or hidden input.

## Rulings

| #   | Question                       | Ruling                                                                                                                                                                                                                                         |
| --- | ------------------------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| R1  | Where does the opt-in live?    | Per machine: a switch per host or group in `userData/ssh-session-logs.json`, keyed by workspace. Not in `hosts.yaml`, so a shared workspace cannot turn logging on for someone else. Nearest wins: the host, then its groups up.               |
| R2  | Where do logs live?            | `userData/session-logs/<workspace>/<host>/`, never in the workspace tree, never synced.                                                                                                                                                        |
| R3  | How long are they kept?        | A size cap only: `terminal.sessionLogMaxMb` (500 MB by default) for all logs on the machine together; past it the oldest are deleted first, across hosts. A log a running session writes is never deleted.                                     |
| R4  | What is written?               | Output only, as plain text: escape sequences stripped, a line a carriage return rewrote kept as it last looked, a full-screen program's drawing replaced by one note line. `terminal.sessionLogRaw` also keeps the raw stream.                 |
| R5  | Hidden input                   | Never written: input is not logged, so text reaches a log only as the remote echoes it, and a no-echo prompt (a password) echoes nothing.                                                                                                      |
| R6  | Secrets                        | The log gets what the screen gets, after the snippet masker; every password, key and passphrase used at connect is masked again, in the text (after stripping, so a secret drawn across a colour change is caught) and in the raw stream.      |
| R7  | Protected or server workspaces | Same as #355's rule for desktop activity: no credential ever, and nothing leaves the machine in this slice. The sidecar records the bound server (`url`, `recording`) so #430 can upload under the server's rules later.                       |

## Files

Each log is `<id>.log`, `<id>.json` and, with the raw switch, `<id>.raw`. The id is the start time in compact
UTC and the session id's first eight letters or digits (`20261013T183000Z-6f1c2d3e`), so ids sort by start.
The sidecar, version 1:

```json
{
  "version": 1,
  "id": "20261013T183000Z-6f1c2d3e",
  "workspaceId": "…",
  "hostId": "web",
  "hostName": "Web",
  "address": "10.0.0.1",
  "port": 22,
  "user": "deploy",
  "startedAt": "2026-10-13T18:30:00.000Z",
  "endedAt": "2026-10-13T18:41:12.000Z",
  "exitCode": 0,
  "reason": "exit",
  "raw": false,
  "server": { "url": "https://wirebench.example", "recording": true }
}
```

`endedAt`, `exitCode` and `reason` are absent while the session runs (or after a crash); `reason` is `closed`
when the window closed the session.

## Surface

- `sessionLog.switches`, `sessionLog.setSwitch` (`on: null` clears a host's or group's own switch),
  `sessionLog.list`, `sessionLog.read` (the last 4 MB of a longer log), `sessionLog.search` (case-insensitive,
  count and first matching line), `sessionLog.delete` (refused while live), `sessionLog.reveal`. All act on the
  calling window's workspace; the renderer names a host and a log by id, never a path. Registered with the SSH
  area only.
- The host details panel's **Session logs** section; a group's context menu has **Log sessions**.
- Settings › Terminal › Session logs: the size limit and **Keep raw output**.
