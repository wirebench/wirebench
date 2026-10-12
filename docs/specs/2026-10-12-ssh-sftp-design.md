# SSH area slice 3: SFTP — design

**Issue:** #357 · **Date:** 2026-10-12 · **Status:** approved in session 2026-10-12 (design sections signed off,
spec written from them)

Builds on: the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, slice S3 in its table, the host
model, `packages/ssh`, `SshService`, the trust prompt and the amendments A1–A7),
[ADR-0021](../adr/0021-a-desktop-area-is-a-module-behind-one-interface.md) (a desktop area is a module),
[ADR-0002](../adr/0002-engine-in-main-process.md) (network and disk work run in main) and
[ADR-0004](../adr/0004-secrets-outside-project-files.md) (secrets outside project files).

## Objective

From any host in the SSH area a user opens a **Files** tab: two panes side by side, this machine on the left and
the host on the right, either of which can be switched to another host. They browse, copy files and folders
between the panes by dragging or from a menu, drop files from the OS file manager onto either pane, rename,
delete, make folders and change permissions, watch every transfer's progress in a strip at the bottom and cancel
any of them. A remote file opens in the system editor and is uploaded each time it is saved. Hosts reached
through a jump chain work exactly like direct ones. Credentials never leave the main process, as in S1.

## Decisions (owner rulings, 2026-10-12)

| #   | Question                              | Ruling                                                                                                                                                                                                                         |
| --- | ------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| R1  | Layout                                | Two panes, this machine and the host. Either pane's place picker can switch to any host, so remote to remote works in the same tab.                                                                                             |
| R2  | How do Files and the terminal relate? | A separate tab kind, `ssh-files`, with its own SSH connection (so its own sign-in and jump chain). The terminal tab gains a **Files** action and the Files tab an **Open terminal** action, each opening or focusing the other. |
| R3  | Editing a remote file                 | Opens in the system's default app for the file from a private temporary copy; every save uploads it while the Files tab is open; a remote change since the download is asked about, never overwritten silently.              |
| R4  | A transfer's target already exists    | Ask on the first clash of a batch: Skip, Keep both (`name (1).ext`), Replace, with "do this for the other clashes" for the rest of that batch. Dismissing the dialog is Skip.                                                 |
| R5  | What may the local pane browse?       | The whole disk, anything the OS user can read and write. This is a deliberate exception to the main process's containment rule (D9), recorded in an ADR.                                                                     |
| R6  | Transport                             | The SSH File Transfer Protocol subsystem over the same hop-dialling code as the terminal (approach A). Not commands over `exec`, not the system `sftp` binary.                                                                  |
| R7  | Surfaces                              | Desktop only, as S1's R4. CLI and MCP file transfer wait for a separate ruling.                                                                                                                                                |

## Non-goals

- CLI and MCP surfaces (R7).
- Resuming an interrupted transfer; a failed or cancelled transfer starts over on Retry.
- Recursive permission changes, changing owner or group, and running anything as another user (`sudo`).
- Dragging out of a pane onto the OS file manager (needs a local file before the drag starts; later).
- Folder sync or compare, creating symlinks, archive and extract on the remote.
- SCP as a fallback for servers without the SFTP subsystem: such a server gets `sftp-unavailable`.
- Local to local copies: the panes exist to move files to and from hosts.
- Audit entries: amendment A1 of the SSH area design still holds (no desktop activity log yet).

## Facts this design rests on

- `packages/ssh/src/session.ts` `openSession` dials the hop chain (`connectHop` per hop, `forwardOut` feeding the
  next hop's `sock`) and opens a PTY shell on the last client, in one function. `exec` already runs a second
  channel on the same connection (the OS probe).
- `apps/desktop/src/main/ssh-service.ts` resolves the chain (`chainFor`), the credentials (`credentialsFor`, from
  `${secret:…}` through the window's secret getter), checks host keys against `userData/ssh-known-hosts.json`
  and records refusals per window for `ssh.trust`. Sessions are owned by the `WebContents` that opened them and
  end on a workspace switch in that window (`sshSessionsEndOnSwitch`). Per-window wiring lives in
  `main/ssh-window.ts`.
- `apps/desktop/src/main/dialog-picks.ts`: today main touches a local path only when it is inside the open
  project or the user picked it in an OS dialog; drops from the OS have no main-side evidence.
- The terminal tab is the non-persisted editor tab kind `'ssh-terminal'` (`renderer/state/editors.ts`,
  `renderer/features/ssh/terminal-tab.tsx`); `connect.ts` opens it; `trust-dialog.tsx` is the host key prompt.
- `ssh2` 1.17 is pinned in `packages/ssh`; its client has `sftp()` with `readdir`, `lstat`, `stat`,
  `realpath`, `mkdir`, `rmdir`, `unlink`, `rename`, `chmod`, `createReadStream` and `createWriteStream`.
- The ssh integration fixture (`packages/ssh/test/helpers/ssh-fixture.ts`) is an in-process `ssh2` server with
  `shell` and `exec` handlers and no `sftp` subsystem.
- #407 (terminal reconnect, merged 2026-10-12) taught `session.ts` to tell a lost connection from an exit
  (`SessionExit.reason`); the dialler split keeps that.

## Design

### D1. `packages/ssh`: one dialler, two channel kinds

`session.ts` is split:

- `dial.ts`: `dialChain({ hops, verifyHostKey }) → Promise<{ client: Client; endAll(): void }>`. It is the
  current hop loop moved out unchanged (errors, host key handling and the `onLost` wiring included).
  `openSession` calls it and opens the shell on `client`, with its signature and behaviour unchanged.
- `sftp.ts`: `openSftp({ hops, verifyHostKey }) → Promise<SftpSession>` dials the chain and opens the
  subsystem. A server that refuses the subsystem is `sftp-unavailable`.

```ts
export interface RemoteEntry {
  readonly name: string;
  readonly type: 'file' | 'dir' | 'symlink' | 'other';
  readonly size: number;
  /** Milliseconds since the epoch. */
  readonly mtime: number;
  /** Permission bits only (`mode & 0o7777`). */
  readonly mode: number;
  /** For a symlink, what it points at, so the pane can open it like a folder; a dangling link is 'other'. */
  readonly targetType?: 'file' | 'dir' | 'other';
}

export interface SftpSession {
  readonly id: string;
  /** The server's absolute form of `path`; `'.'` is the login directory. */
  realpath(path: string): Promise<string>;
  list(path: string): Promise<readonly RemoteEntry[]>;
  stat(path: string): Promise<RemoteEntry>;
  mkdir(path: string): Promise<void>;
  rename(from: string, to: string): Promise<void>;
  /** A directory with `recursive` is emptied depth first; without it, a non-empty directory is refused. */
  remove(path: string, options: { readonly recursive: boolean }): Promise<void>;
  chmod(path: string, mode: number): Promise<void>;
  readStream(path: string): Readable;
  writeStream(path: string, options: { readonly mode?: number }): Writable;
  close(): void;
  onClose(listener: () => void): () => void;
}
```

`list` reads a directory with `readdir`, then `stat`s each symlink to fill `targetType`. Paths are POSIX strings
passed to the server as they are; the package never normalises a remote path beyond joining with `/`
(`joinRemote(dir, name)`). Status codes from the server map to error codes (D7).

### D2. Main: `SftpService` and channels

`apps/desktop/src/main/sftp-service.ts`, wired per window in `ssh-window.ts` beside `SshService`. It reuses
`SshService`'s chain resolution, credentials and host key path: those move into a small shared helper
(`ssh-connect.ts`: `prepareHops(sender, hostId)` and the `verifyHostKey` that records refusals), so both
services refuse an untrusted key the same way and `ssh.trust` serves both. A Files pane that hits
`ssh-host-key-new` or `ssh-host-key-changed` shows the existing trust dialog and retries.

Ownership is as in S1: an SFTP session belongs to the `WebContents` that opened it, and every channel refuses a
foreign or dead id (`sftp-session-unknown`). A workspace switch in a window ends that window's SFTP sessions and
cancels its transfers; closing the window does the same.

Channels, all under `sftp.` in `shared/ipc.ts`, with schemas in `shared/sftp-wire.ts`:

| Channel          | Request                                                   | Response / notes                                                                              |
| ---------------- | --------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| `sftp.open`      | `{ hostId }`                                              | `{ sessionId, home }` (`home` is `realpath('.')`). Errors as `ssh.connect`.                   |
| `sftp.close`     | `{ sessionId }`                                           | Idempotent; cancels that session's transfers and ends its edits.                              |
| `sftp.list`      | `{ place, path }`                                         | `{ path, entries }` with the absolute path the server or OS resolved.                         |
| `sftp.mkdir`     | `{ place, path }`                                         | Refuses an existing path (`sftp-exists`).                                                     |
| `sftp.rename`    | `{ place, from, to }`                                     | Refuses an existing `to` (`sftp-exists`): a rename never replaces.                            |
| `sftp.remove`    | `{ place, paths, recursive }`                             | Removes in order; stops at the first failure and says which.                                  |
| `sftp.chmod`     | `{ place, path, mode }`                                   | Remote only; `mode` is `0`–`0o7777`.                                                          |
| `sftp.copy`      | `{ batchId, from: { place, paths }, to: { place, dir } }` | Queues a batch (D3); answers at once with the transfer ids.                                   |
| `sftp.resolve`   | `{ batchId, decision, applyToRest }`                      | Answers a conflict question (D3).                                                             |
| `sftp.cancel`    | `{ transferId }`                                          | Idempotent.                                                                                   |
| `sftp.retry`     | `{ transferId }`                                          | A failed or cancelled transfer starts over.                                                   |
| `sftp.localHome` | `{}`                                                      | `{ home, downloads }` for the local pane's first place.                                       |
| `sftp.edit`      | `{ sessionId, path, confirmedLarge? }`                    | Starts an edit (D4); `{ editId }`.                                                            |
| `sftp.endEdit`   | `{ editId }`                                              | Stops watching and deletes the copy.                                                          |
| `sftp.editReply` | `{ editId, decision: 'overwrite' \| 'keep-remote' }`      | Answers a remote-changed question (D4).                                                       |

`place` is `{ kind: 'local' } | { kind: 'remote', sessionId }`. Local operations use `node:fs/promises` on the
path as given (R5) and map errors to `local-fs-failed` with the `errno` code. Files dropped from the OS reach
`sftp.copy` as local paths; the preload reads them with `webUtils.getPathForFile`.

Events: `sftp.transfer { transferId, batchId, state, done, total, bytesPerSecond, error? }` (throttled to four a
second per transfer, plus every state change), `sftp.conflict { batchId, transferId, existing, incoming,
remaining }` (each side `{ size, mtime }`), `sftp.closed { sessionId }`, `sftp.edit { editId, state:
'watching' | 'uploading' | 'uploaded' | 'remote-changed' | 'failed', error? }`.

### D3. Transfers

A transfer is one file; a batch is what one drag, drop or menu action asked for. `transfers.ts` in main holds a
queue per window:

- Folders are walked depth first when the batch starts: each file becomes a transfer, each folder a `mkdir` on
  the target before its files (an existing folder is reused, not a conflict). Symlinks to files are followed;
  symlinks to folders are not walked (no loops) and are reported as `skipped`.
- Three transfers run at a time per window; the rest wait as `queued`.
- A transfer pipes a read stream to a write stream: local to remote, remote to local, or remote to remote
  through main (two SFTP sessions, R1). Copying a folder into itself or one of its descendants is refused
  before anything is written.
- Before writing, the target is `stat`ed. A clash pauses that transfer as `waiting` and emits `sftp.conflict`;
  the answer and its "apply to the rest" box (R4) decide this and later clashes of the batch, and without the
  box each later clash asks again. Keep both picks the first free `name (n).ext` in the target folder. Every
  write goes to `name.wirebench-part` and is renamed over the target at the end, so a failed replace leaves the
  old file and a failed new file leaves nothing but the part file, which is removed.
- Cancel destroys both streams and removes the part file; the transfer ends `cancelled`. A broken connection
  fails every transfer on it with the cause; Retry starts the file over.
- States: `queued`, `waiting`, `running`, `done`, `failed`, `cancelled`, `skipped`.
- Mode: an upload keeps the local file's permission bits; a download leaves the local default (umask).

### D4. Editing in the system editor

`sftp.edit` downloads the file to `userData/sftp-edit/<random>/<name>` (the folder made with mode `0700`),
records the remote `size` and `mtime`, and opens it with `shell.openPath`. A watcher (`fs.watch`, debounced
500 ms, compared by content hash so a touch without a change uploads nothing) uploads on each save:

1. `stat` the remote; if `size` or `mtime` differs from the recorded pair, emit `remote-changed` and wait for
   `sftp.editReply`: **Overwrite** uploads, **Keep remote** stops watching and leaves the local copy for the
   user to compare (the banner offers to reveal it) until the tab closes.
2. Upload through the same part-file-then-rename as a transfer, then record the new remote `size` and `mtime`.
   Uploads of one edit run one at a time; a save during an upload queues one more with the latest content.

Edits belong to the Files tab's SFTP session: closing the tab, the window, or a workspace switch ends them and
deletes the copies. Start-up deletes any `userData/sftp-edit` folder left by a crash. Files over 50 MB ask
before opening (the renderer asks, then sends `confirmedLarge`).

### D5. Renderer: the Files tab

`apps/desktop/src/renderer/features/ssh/files/`. A new editor tab kind `'ssh-files'`, **not persisted**, titled
`<host name> · Files`, with the host's status dot.

- **Entry points:** "Open files" on the host card menu, the host details panel and the area's ⌘K and ⌘P
  entries ("Open files on host…"); **Files** on the terminal tab's toolbar; **Open terminal** on the Files tab's
  toolbar. Each opens or focuses the other tab for the same host (R2).
- **Panes:** two, split evenly and resizable. Each has a place picker (This machine, then every host by path
  and name), Back, Up, Refresh, a hidden-files toggle, and a path bar: crumbs to click, and on click or ⌘L a
  text field where Enter navigates, `~` is the place's home and Escape restores the crumbs. A path that does
  not exist shows the error under the bar and the pane stays where it was. The local pane starts in the user's
  home folder.
- **List:** columns Name, Size, Modified, Permissions (remote; `rwxr-x---` form), sortable by header, folders
  first. Single, shift and ⌘ selection. Keys: Enter opens a folder or edits a file, Backspace goes up, F2
  renames in place, Delete asks then deletes, ⌘A selects all, Tab moves to the other pane.
- **Context menu:** Open / Edit, Copy to other pane, Rename, Delete…, Permissions…, New folder, Copy path,
  Refresh.
- **Drag and drop:** a selection dragged onto the other pane (or onto a folder in it) copies there; files
  dropped from the OS onto a remote pane are uploaded there. Dropping onto the same pane, and OS drops onto the
  local pane, do nothing.
- **Transfers strip:** collapsible, under the panes, shown while any transfer exists. Each row: direction,
  name, target, bytes done and total, speed, a bar, Cancel; finished rows tick and clear with "Clear done";
  failed rows show the cause and Retry. Closing a Files tab with transfers running asks first, then cancels
  them.
- **Dialogs:** the conflict dialog (R4, both sides' size and modified time), Permissions (owner, group and
  others read/write/execute checkboxes and an octal field kept in step), Delete (lists names, says a folder
  is removed with its contents), the trust dialog reused from S1.
- **Editing banner:** "n files open in an editor · uploads on save" with each file's last upload state, the
  remote-changed question inline, and Stop editing.
- **Preferences** (local, per machine, `hosts-prefs.ts` style): hidden files shown, each host's last folder,
  pane split ratio.

### D6. Commands

Ids in `shared/commands.ts` and the catalog: `ssh.openFiles` (takes a host id), `sftp.refresh`,
`sftp.newFolder`, `sftp.rename`, `sftp.delete`, `sftp.permissions`, `sftp.copyToOtherPane`,
`sftp.toggleHidden`, `sftp.focusPathBar`. Registered by the ssh renderer half; the shell gains nothing.

### D7. Errors

| Code                     | When                                                 | The message says                            |
| ------------------------ | ---------------------------------------------------- | ------------------------------------------- |
| `sftp-unavailable`       | the server refused the SFTP subsystem                | the host, and that it offers no SFTP        |
| `sftp-not-found`         | the path does not exist (`NO_SUCH_FILE`)             | the path                                    |
| `sftp-permission-denied` | the server refused (`PERMISSION_DENIED`)             | the path and the operation                  |
| `sftp-exists`            | a rename or mkdir target exists                      | the path                                    |
| `sftp-failed`            | any other status, or an unsafe name (D9)             | the path, the operation and the status code |
| `sftp-session-unknown`   | a channel names a foreign or closed session          | nothing more                                |
| `local-fs-failed`        | a local read, write, list, rename or remove failed   | the path and the `errno` code               |

A cancelled transfer is a state, not an error. Connect failures keep the S1 codes (`ssh-host-key-new`,
`ssh-host-key-changed`, `ssh-auth-failed`, `ssh-connect-failed`, `ssh-host-unknown`, `ssh-host-incomplete`,
`secret-missing`). All are `WirebenchError`s with `details`.

### D8. Jump hosts

A Files tab dials the same chain as a terminal (`dialChain`); nothing is specific to SFTP. Two remote panes on
hosts behind the same bastion dial it twice (one chain per SFTP session); sharing a hop between sessions is a
later optimisation, not part of this slice.

### D9. Security

- Credentials, host keys and session ownership are as in S1 (D9 there): values only in main, trust only by a
  click, a `WebContents` acts only on its own SFTP sessions, transfers and edits.
- **Local file access (R5).** The `sftp.*` channels read, write, list, rename and delete any local path the
  renderer names, without the project containment or dialog-pick check that every other file channel applies.
  This is a deliberate, owner-ruled exception, scoped to these channels: they are registered only while the
  SSH area is switched on (`WIREBENCH_AREAS=ssh=off` removes them), and no other channel gains the access. An
  ADR records it with its cost: a compromised renderer could read a local file and upload it to a host the
  workspace already trusts.
- Remote names are never trusted as local path parts: a download target is `join(targetDir, name)` only after
  refusing names that contain `/`, `\` or NUL or equal `.` or `..` (`sftp-failed` with
  `details.reason: 'unsafe-name'`), so a hostile server cannot write outside the chosen folder.
- Edit copies live under `userData/sftp-edit` with mode `0700` and are deleted when the edit ends and at
  start-up.
- No bytes of any file are logged; transfer events carry names, sizes and states.

## Testing

- `packages/ssh` unit: `joinRemote`, entry mapping from `readdir`/`stat` attributes, status code to error code.
- `packages/ssh` integration: the fixture gains an `sftp` subsystem handled by a spawned OpenSSH `sftp-server`
  rooted in a temporary folder (found at the usual Linux and macOS paths; the tests skip with a message where
  it is missing, and fail instead of skipping when `CI` is set on Linux). Cases: realpath, list with a symlink
  and a dangling one, stat, mkdir, rename refusing an existing target, remove recursive, chmod, a stream round
  trip of 5 MB, the same through a jump hop, `sftp-unavailable` from a server without the subsystem,
  `PERMISSION_DENIED` mapping. `openSession`'s existing tests pass unchanged after the `dialChain` split.
- Desktop unit: the transfer queue (concurrency limit, folder walk order, conflict pause and the batch rule,
  keep-both naming, replace through the part file, cancel removes the part file, a failed connection fails its
  transfers, retry), unsafe remote names refused on download, the edit watcher (upload on change, no upload on
  touch, remote-changed question, cleanup at end and start-up), session ownership and the workspace switch.
- Desktop e2e (CI only, `xvfb-run`): against the fixture, open Files from the host card, see the remote folder,
  make a folder, copy a file from the local pane by dragging, rename it, change its permissions, copy it back,
  start a large transfer and cancel it, and open Files from a terminal tab.

## Success criteria

- A host reached through a jump host lists its files like a direct one, slower only by the extra hop.
- A 1 GB upload and download each run without the renderer stalling, show steady progress, and cancel within a
  second leaving no partial file.
- A conflict never overwrites without the user choosing Replace; a failed replace leaves the old file intact.
- A file edited in the system editor reaches the host on every save, and a remote change since the download is
  always asked about.
- Switching the area off removes the Files tab, its commands and every `sftp.*` channel.

## Docs

- `site/` docs page "Hosts and terminals" gains a "Files" section: opening, copying, conflicts, editing, the
  local access stance.
- ADR "The SFTP local pane reads and writes any local path" (R5).
- Command catalog regenerated (`pnpm docs:commands`).

## Delivery

Pull requests, in order, each green on `pnpm check` and each a working app:

1. `dialChain` split, `openSftp`, `SftpSession`, the fixture's SFTP subsystem and the package tests.
2. `SftpService`, the shared connect helper, the browse and file-operation channels, local operations.
3. The Files tab with one remote pane: entry points, list, path bar, hidden toggle, context menu, rename,
   delete, new folder, permissions, trust prompt.
4. The local pane, the transfer queue, the transfers strip, conflicts, drag between panes and drops from the
   OS.
5. Remote to remote: the place picker switching a pane to another host, transfers between two SFTP sessions.
6. Editing in the system editor with upload on save.
7. Docs, the ADR and the e2e.

## Boundaries

- `packages/ssh` stays free of the engine and Electron; the SFTP code is Node only.
- The renderer never touches the network or the file system; every file operation is a typed channel to main.
- A later slice (forwarding, workspaces) extends the ssh module; it does not edit the shell.
