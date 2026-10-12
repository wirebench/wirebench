# Plan: SSH area slice 3 — SFTP

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or
> superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for
> tracking.

**Spec:** `docs/specs/2026-10-12-ssh-sftp-design.md` (issue #357). The plan argues from the spec; read both, and
the SSH area design (`docs/specs/2026-10-08-ssh-area-design.md`, D3, D4, D9 and A1–A7) for the session model.

**Goal:** A **Files** tab per host with a local and a remote pane (either switchable to another host), copying
by drag, menu and OS drop with a transfers strip, conflicts, cancel and retry; rename, delete, new folder and
permissions; editing a remote file in the system editor with upload on save; jump hosts as for the terminal.

**Architecture:** Seven pull requests, one implementation issue each, in the spec's delivery order. PR 1 is
`packages/ssh` only: the hop dialler moves out of `session.ts` into `dial.ts`, and `sftp.ts` opens the SFTP
subsystem over it. PR 2 adds `SftpService` in main beside `SshService`, sharing the connect path through a new
`ssh-connect.ts`, and the `sftp.*` channels for browsing and file operations. PRs 3–6 are the renderer tab and
main's transfer queue and edit watcher, each a working app. PR 7 is docs, the ADR and the e2e.

**Tech stack:** TypeScript (ESM, Node ≥ 24), `ssh2` 1.17 (pinned), zod 4, vitest (root `vitest.config.ts`
projects `ssh-unit`, `ssh-integration` and the desktop unit project), Electron 44, React 19 + zustand + Radix,
Playwright `_electron` e2e.

## Global constraints

- `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` green before every commit; one
  commit per task. `pnpm test:perf` before a push. e2e runs in CI only (`pnpm build && xvfb-run -a pnpm test:e2e`);
  local checks headless under `nice`.
- Never name the product that motivated this feature anywhere; `pnpm check:banned-terms` enforces part of this.
- Commits as Mohammed Naami <m.naami@outlook.com>; no `Co-Authored-By`, no `Claude-Session` trailer; PR
  descriptions end with their last section (no generated-by footer).
- `packages/ssh` imports neither `@wirebench/engine` nor Electron (`scripts/engine-layers.test.ts`).
- No channel response, event, log line or error carries a credential, a key's bytes or any file content.
  Transfer events carry names, sizes and states only.
- The `sftp.*` channels are registered only while the SSH area is enabled; with `WIREBENCH_AREAS=ssh=off` none
  exists (extend `apps/desktop/test/areas-switch.test.ts`).
- Local paths over `sftp.*` are used as given (spec R5); no other channel loosens `DialogPicks` or project
  containment.
- A remote name becomes a local path part only through `safeLocalName` (Task 9); `''`, `.`, `..` and names with
  `/`, `\` or NUL are refused.
- A new command id needs a `COMMAND_CATALOG` entry and a handler (`test/renderer/command-registry.test.ts`); run
  `pnpm docs:commands` after.
- Renderer code never imports a value from `shared/sftp-wire.ts` eagerly (the renderer CSP trap,
  `test/renderer-eager-imports.test.ts`); constants it needs go in `shared/sftp-defaults.ts`.
- `ssh-files` tabs are never persisted (`renderer/state/tab-sets.ts` drops them like `ssh-terminal`).
- PR 1 starts after #407 (terminal reconnect) merges, because both change `packages/ssh/src/session.ts`.

## Review focus

1. **A remote name with `../` or `/` in it** (hostile or broken server): a download refuses it and never writes
   outside the target folder. Test in Task 9.
2. **The Files tab closes, the window closes or the workspace switches mid-transfer**: every stream is
   destroyed, every `.wirebench-part` file removed, no event goes to a gone `WebContents`. Tests in Tasks 5
   and 9.
3. **The same file twice in one batch, or a folder copied into itself** (`/a` → `/a/b`): the second clashes like
   any other, and copying a folder into its own descendant is refused before any write. Test in Task 9.
4. **A save from the editor while the previous save is still uploading**: uploads for one edit are serialised
   and the last content wins; never two part files at once. Test in Task 12.
5. **A folder of thousands of entries, or a symlink loop**: listing is one `readdir` plus one `stat` per symlink,
   the list renders a window of rows (virtualised), and a copy never walks a folder symlink. Tests in Tasks 2,
   5, 7 and 9.

---

## PR 1 — `packages/ssh`: dialler and SFTP session (issue: SFTP 1/7)

### Task 1: Move the hop dialler into `dial.ts`

**Files:** create `packages/ssh/src/dial.ts`, `packages/ssh/test/integration/dial.test.ts`; modify
`packages/ssh/src/session.ts`, `packages/ssh/src/index.ts`; `packages/ssh/test/integration/session.test.ts`
stays unchanged and green.

**Interfaces:**

- Produces:

  ```ts
  export interface DialOptions {
    /** Outermost first, target last. */
    readonly hops: readonly HopCredentials[];
    readonly verifyHostKey: (
      hop: { readonly address: string; readonly port: number },
      key: KnownHostEntry,
    ) => Promise<'accept' | 'reject'>;
  }
  export interface DialledChain {
    /** The client connected to the last hop. */
    readonly client: Client;
    /** Ends every hop's client; idempotent. */
    endAll(): void;
    /** Fires once when any hop's connection is lost after `ready`. */
    onLost(listener: () => void): () => void;
  }
  export function dialChain(options: DialOptions): Promise<DialledChain>;
  ```

- `OpenSessionOptions` becomes `DialOptions & { readonly cols: number; readonly rows: number }`; `openSession`
  keeps its signature and behaviour.

- [ ] Test first in `dial.test.ts` against the existing fixture: one hop resolves with a client that can `exec`;
      two hops (a second fixture as the target) resolve; a refused key rejects with `ssh-host-key-new`; a wrong
      password rejects with `ssh-auth-failed`; `endAll()` twice does not throw; stopping the jump fixture fires
      `onLost` once.
- [ ] Move `connectHop`, `forwardOut` and the loop from `openSession` into `dialChain` without changing their
      error mapping. `openSession` becomes `const chain = await dialChain(options)`, the shell on
      `chain.client`, and `wrap(channel, chain.client, chain.endAll)`, with `chain.onLost` wired where the
      inline `onLost` was.
- [ ] Run `pnpm --filter @wirebench/ssh test`; `session.test.ts` passes unchanged.
- [ ] Commit `refactor(ssh): dial the hop chain in its own module`.

### Task 2: `openSftp` and `SftpSession`

**Files:** create `packages/ssh/src/sftp.ts`, `packages/ssh/test/unit/sftp.test.ts`,
`packages/ssh/test/integration/sftp.test.ts`; modify `packages/ssh/src/index.ts`,
`packages/ssh/test/helpers/ssh-fixture.ts`.

**Interfaces:**

- Consumes: `dialChain`, `DialOptions` (Task 1).
- Produces: `RemoteEntry` and `SftpSession` exactly as spec D1, plus:

  ```ts
  export function openSftp(options: DialOptions): Promise<SftpSession>;
  /** `dir` + '/' + `name` with one slash; throws when `name` contains '/'. */
  export function joinRemote(dir: string, name: string): string;
  /** The parent of a POSIX path; the parent of '/' is '/'. */
  export function parentRemote(path: string): string;
  export type SftpOp = 'list' | 'stat' | 'mkdir' | 'rename' | 'remove' | 'chmod' | 'read' | 'write' | 'realpath';
  /** sftp-unavailable | sftp-not-found | sftp-permission-denied | sftp-exists | sftp-failed, details { path, op, status? }. */
  export class SftpError extends SshModelError {}
  export function sftpErrorOf(error: unknown, op: SftpOp, path: string): SftpError;
  ```

- Fixture: `startSshFixture({ sftp?: { root: string } | 'refuse' })`. With a root, the `sftp` subsystem pipes
  the channel to a spawned OpenSSH `sftp-server` (`-d <root>` where supported, else `cwd: root`), looked up at
  `/usr/lib/openssh/sftp-server`, `/usr/libexec/openssh/sftp-server` and `/usr/libexec/sftp-server`, exported
  as `sftpServerPath(): string | undefined`. `'refuse'` rejects the subsystem.

- [ ] Unit tests first: `joinRemote('/', 'a') === '/a'`, `joinRemote('/a/', 'b') === '/a/b'`,
      `joinRemote('/a', 'b/c')` throws; `parentRemote('/a/b') === '/a'`, `parentRemote('/') === '/'`; entry
      mapping from ssh2 `Attributes` (`mode & 0o170000` → type, `mode & 0o7777`, `mtime * 1000`);
      `sftpErrorOf({ code: 2 })` → `sftp-not-found`, `code: 3` → `sftp-permission-denied`, `code: 4` with op
      `mkdir` or `rename` → `sftp-exists`, any other code → `sftp-failed` with `details.status`.
- [ ] Integration tests (skip with a message when `sftpServerPath()` is undefined; fail instead when
      `process.env.CI` is set on Linux): `realpath('.')` is the root; `list` of a folder holding a file, a
      folder, a link to the folder (`targetType: 'dir'`) and a dangling link (`targetType: 'other'`); a folder of
      2 000 files lists in one call; `stat`; `mkdir` twice → `sftp-exists`; `rename` onto an existing name →
      `sftp-exists` and both files intact; `remove` of a non-empty folder without `recursive` → `sftp-failed`,
      with `recursive` → gone, and a folder symlink inside it is unlinked without touching its target; `chmod
      (path, 0o640)` then `stat().mode === 0o640`; a 5 MB random buffer through `writeStream` then `readStream`
      round-trips byte for byte; the same round trip through a jump hop; a fixture with `sftp: 'refuse'` →
      `openSftp` rejects `sftp-unavailable`; `list` of a `chmod 000` folder → `sftp-permission-denied`;
      `close()` fires `onClose` once.
- [ ] Implement `openSftp`: `dialChain`, then `client.sftp(…)`; an error there → `sftp-unavailable` `{ host }`
      and `endAll()`. `rename` first `lstat`s `to` and refuses with `sftp-exists` (servers differ on
      overwrite). `remove` with `recursive` walks with `readdir`, never following a folder symlink. Every
      callback error goes through `sftpErrorOf`. `close()` ends the SFTP channel and calls `endAll()`; a lost hop
      calls the `onClose` listeners.
- [ ] Commit `feat(ssh): SFTP sessions over the hop chain`.

## PR 2 — main: `SftpService` and file operation channels (issue: SFTP 2/7)

### Task 3: Share the connect path in `ssh-connect.ts`

**Files:** create `apps/desktop/src/main/ssh-connect.ts`, `apps/desktop/test/ssh-connect.test.ts`; modify
`apps/desktop/src/main/ssh-service.ts`; `apps/desktop/test/ssh-service.test.ts` stays unchanged and green.

**Interfaces:**

- Produces:

  ```ts
  export interface SshConnector {
    /** The hops to `hostId` with credentials, outermost first; the S1 refusals come before any network. */
    prepareHops(sender: WebContents, hostId: string): Promise<HopCredentials[]>;
    /** Checks the machine's known hosts and records a refusal that sender may then trust. */
    verifierFor(sender: WebContents): DialOptions['verifyHostKey'];
    /** Turns a refused connect into ssh-host-key-new / ssh-host-key-changed with the fingerprint. */
    refusalError(sender: WebContents, error: unknown): unknown;
  }
  export function createSshConnector(deps: SshServiceDeps & { refusals: RefusalStore }): SshConnector;
  ```

- `SshService` takes an `SshConnector` and keeps `trust`, `knownHosts`, `forgetHostKey`; the `RefusalStore` (the
  per-sender refusals map, moved as is) is shared by both, so `ssh.trust` serves terminal and Files alike.

- [ ] Test first: with a fake hosts model and secret getter, a host behind a jump yields two hops in order; a
      missing secret → `secret-missing`; an unknown key records a refusal for that sender only, and a trust
      from another sender is refused with `ssh-host-key-unexpected`.
- [ ] Move `chainFor`, `credentialsFor`, `requireAgent` and the verifier from `SshService` into the connector
      unchanged. `ssh-service.test.ts` passes unchanged.
- [ ] Commit `refactor(desktop): share the SSH connect path`.

### Task 4: Wire types and channels

**Files:** create `apps/desktop/src/shared/sftp-wire.ts`, `apps/desktop/src/shared/sftp-defaults.ts`,
`apps/desktop/test/sftp-wire.test.ts`; modify `apps/desktop/src/shared/ipc.ts`.

**Interfaces:**

- Produces the schemas for every channel and event in spec D2. Shapes later tasks use:

  ```ts
  export type SftpPlaceWire = { kind: 'local' } | { kind: 'remote'; sessionId: string };
  export interface SftpEntryWire {
    name: string;
    type: 'file' | 'dir' | 'symlink' | 'other';
    size: number;
    mtime: number;
    /** Remote only. */
    mode?: number;
    targetType?: 'file' | 'dir' | 'other';
  }
  export interface SftpCopyRequest {
    batchId: string;
    from: { place: SftpPlaceWire; paths: string[] };
    to: { place: SftpPlaceWire; dir: string };
  }
  export type TransferStateWire = 'queued' | 'waiting' | 'running' | 'done' | 'failed' | 'cancelled' | 'skipped';
  export type ConflictDecisionWire = 'skip' | 'keep-both' | 'replace';
  ```

- `sftp-defaults.ts`: `TRANSFER_CONCURRENCY = 3`, `PROGRESS_EVENTS_PER_SECOND = 4`, `EDIT_DEBOUNCE_MS = 500`,
  `EDIT_ASK_ABOVE_BYTES = 50 * 1024 * 1024`, `PART_SUFFIX = '.wirebench-part'`.

- [ ] Test first: each request schema refuses an unknown key; `chmod.mode` refuses `-1` and `0o10000`;
      `place.kind` refuses anything but `local` and `remote`; `remove.paths` and `copy.from.paths` refuse an
      empty array.
- [ ] Add `channels.sftp.*` and `events.sftp.*` to `ipc.ts` (`defineChannel`, `defineEvent`).
- [ ] Commit `feat(desktop): SFTP wire types and channels`.

### Task 5: `SftpService` with browse and file operations

**Files:** create `apps/desktop/src/main/sftp-service.ts`, `apps/desktop/src/main/local-fs.ts`,
`apps/desktop/src/main/areas/sftp-channels.ts`, `apps/desktop/test/sftp-service.test.ts`,
`apps/desktop/test/local-fs.test.ts`; modify `apps/desktop/src/main/areas/ssh.ts` (register),
`apps/desktop/src/main/ssh-window.ts` (per-window construction, the switch hook),
`apps/desktop/test/areas-switch.test.ts`.

**Interfaces:**

- Consumes: `SshConnector` (Task 3), `openSftp` (Task 2), the wire types (Task 4).
- Produces:

  ```ts
  export class SftpService {
    constructor(deps: { connector: SshConnector; emit: SshServiceDeps['emit']; open?: typeof openSftp });
    open(sender: WebContents, request: { hostId: string }): Promise<{ sessionId: string; home: string }>;
    close(sender: WebContents, request: { sessionId: string }): void;
    list(sender: WebContents, request: { place: SftpPlaceWire; path: string }): Promise<{ path: string; entries: SftpEntryWire[] }>;
    mkdir(sender: WebContents, request: { place: SftpPlaceWire; path: string }): Promise<void>;
    rename(sender: WebContents, request: { place: SftpPlaceWire; from: string; to: string }): Promise<void>;
    remove(sender: WebContents, request: { place: SftpPlaceWire; paths: string[]; recursive: boolean }): Promise<void>;
    chmod(sender: WebContents, request: { place: SftpPlaceWire; path: string; mode: number }): Promise<void>;
    /** For the transfer queue and the edit service: the owned session, or sftp-session-unknown. */
    session(sender: WebContents, sessionId: string): SftpSession;
    onSessionClosed(listener: (sender: WebContents, sessionId: string) => void): () => void;
    disposeFor(sender: WebContents): void;
    disposeAll(): void;
  }
  ```

  `local-fs.ts` exports `localList`, `localStat`, `localMkdir`, `localRename` (refuses an existing target with
  `sftp-exists`), `localRemove`, `localReadStream`, `localWriteStream`, `localHome(): { home; downloads }`, each
  mapping a Node error to `local-fs-failed` `{ path, errno }`.

- [ ] Test first, `sftp-service.test.ts` with a fake `open`: another sender's `list` → `sftp-session-unknown`;
      `close` is idempotent and emits `sftp.closed`; `disposeFor(sender)` closes only that sender's sessions; a
      session closing on its own emits `sftp.closed` to its owner only, and nothing once the window is
      destroyed; a host key refusal comes back as `ssh-host-key-new` with the fingerprint; `chmod` on a local
      place → `sftp-failed` `{ reason: 'local-chmod' }`.
- [ ] `local-fs.test.ts` on a temp folder: a hidden file is listed (hiding is the renderer's job); a symlink to a
      folder has `targetType: 'dir'`; `rename` onto an existing name is refused; `remove` recursive; `ENOENT` →
      `local-fs-failed` with `errno: 'ENOENT'`; 2 000 entries list through one `readdir` and bounded-concurrency
      `lstat`s.
- [ ] Extend `areas-switch.test.ts`: with `ssh=off` no `sftp.*` handler is registered.
- [ ] Implement; register handlers in `sftp-channels.ts` the way `registerSshChannels` does (the sender is the
      owner); construct per window in `ssh-window.ts`; the workspace-switch hook also calls
      `sftp.disposeFor(sender)`.
- [ ] Commit `feat(desktop): SFTP sessions and file operations in main`.

## PR 3 — renderer: the Files tab with one remote pane (issue: SFTP 3/7)

### Task 6: Tab kind, store and entry points

**Files:** create `apps/desktop/src/renderer/features/ssh/files/open-files.ts`, `files-store.ts`,
`files-tab.tsx`, `files-prefs.ts`; modify `apps/desktop/src/renderer/state/editors.ts` (kind `'ssh-files'` with
`hostId`), `apps/desktop/src/renderer/state/tab-sets.ts`, `apps/desktop/src/renderer/shell/editor-area.tsx`
(render and title), `apps/desktop/src/renderer/features/ssh/host-menus.tsx`, `host-details.tsx`,
`terminal-tab.tsx` (toolbar **Files**), `apps/desktop/src/shared/commands.ts`,
`apps/desktop/src/shared/command-catalog.ts`, the ssh renderer half's command registration; tests under
`apps/desktop/test/renderer/`.

**Interfaces:**

- Produces:

  ```ts
  /** Opens or focuses the Files tab for `hostId`. */
  export function openFiles(hostId: string): void;
  /** Opens or focuses the terminal tab for `hostId` (through connect.ts). */
  export function openTerminal(hostId: string): void;
  export interface PaneState {
    place: { kind: 'local' } | { kind: 'remote'; hostId: string; sessionId?: string };
    path: string;
    home: string;
    entries: SftpEntryWire[];
    selected: string[];
    history: string[];
    status: 'idle' | 'connecting' | 'loading' | 'error';
    error?: { code: string; message: string };
  }
  // files-store.ts: per Files tab id, { left: PaneState; right: PaneState; showHidden: boolean }
  ```

- [ ] Tests first: `openFiles` twice focuses one tab; `tab-sets` drops `ssh-files` on save; `ssh.openFiles` is in
      the catalog and registered only when the area is on; ⌘K "Open files on host…" lists hosts; the terminal
      tab's **Files** and the Files tab's **Open terminal** open or focus the other.
- [ ] Implement the tab: the right pane calls `sftp.open` for the tab's host (the left pane is a placeholder
      until Task 10), shows the trust dialog on `ssh-host-key-new` / `-changed` and retries, starts at the
      host's last folder from `files-prefs.ts` or at `home`. Closing the tab calls `sftp.close`.
- [ ] Run `pnpm docs:commands`. Commit `feat(desktop): Files tab for a host`.

### Task 7: The pane: list, path bar, navigation

**Files:** create `apps/desktop/src/renderer/features/ssh/files/file-pane.tsx`, `path-bar.tsx`, `file-list.tsx`,
`format.ts`; tests `apps/desktop/test/renderer/files-format.test.ts`, `files-path-bar.test.tsx`,
`files-list.test.tsx`.

- [ ] Tests first: `modeString(0o750) === 'rwxr-x---'`; sizes (`0 B`, `1.0 KB`, `12 MB`); `sortEntries` puts
      folders (and links to folders) first, then the chosen column; entries starting with `.` hidden unless
      shown. Path bar: crumbs for `/var/log/app`, a crumb click navigates, ⌘L or a click shows the field, Enter
      navigates, `~` → the pane's home, Escape restores; an `sftp-not-found` answer shows the message under the
      bar and keeps the old listing. List: 5 000 entries render fewer than 200 row elements (virtualised); shift
      and ⌘ selection; Enter on a folder opens it; Backspace goes up; Tab focuses the other pane.
- [ ] Implement with the existing input and list classes in `features/ssh`; the hidden toggle and each host's
      last folder are saved in `files-prefs.ts` (the `hosts-prefs.ts` pattern).
- [ ] Commit `feat(desktop): Files pane with path bar and navigation`.

### Task 8: Operations and dialogs

**Files:** create `apps/desktop/src/renderer/features/ssh/files/file-menu.tsx`, `permissions-dialog.tsx`,
`delete-dialog.tsx`; modify `file-pane.tsx`; tests `apps/desktop/test/renderer/files-permissions.test.tsx`,
`files-ops.test.tsx`.

- [ ] Tests first: the permissions dialog keeps nine checkboxes and the octal field in step (`640` ↔ boxes), an
      invalid octal disables Apply, and setuid, setgid and sticky bits it does not show are preserved; F2 rename
      commits on Enter, cancels on Escape, refuses an empty name or one containing `/`; delete lists the names
      and says folders go with their contents; New folder creates and selects it; every action refreshes the
      pane and shows a refusal as a toast with the error message.
- [ ] Implement the context menu (Open / Edit stays disabled until PR 6, Copy to other pane until PR 4) and the
      commands `sftp.refresh`, `sftp.newFolder`, `sftp.rename`, `sftp.delete`, `sftp.permissions`,
      `sftp.toggleHidden`, `sftp.focusPathBar`. Run `pnpm docs:commands`.
- [ ] Commit `feat(desktop): rename, delete, new folder and permissions in Files`.

## PR 4 — transfers: local pane, queue, strip, conflicts (issue: SFTP 4/7)

### Task 9: The transfer queue in main

**Files:** create `apps/desktop/src/main/transfers.ts`, `apps/desktop/src/main/safe-name.ts`,
`apps/desktop/test/transfers.test.ts`, `apps/desktop/test/safe-name.test.ts`; modify `sftp-service.ts`,
`areas/sftp-channels.ts`, `ssh-window.ts`.

**Interfaces:**

- Consumes: `SftpService.session`, `onSessionClosed` (Task 5), `local-fs.ts`.
- Produces:

  ```ts
  /** The name unchanged, or sftp-failed { reason: 'unsafe-name' } for '', '.', '..' or a name with '/', '\\' or NUL. */
  export function safeLocalName(name: string): string;
  /** 'a.txt' → 'a (1).txt', then 'a (2).txt'…; 'archive.tar.gz' → 'archive (1).tar.gz'; '.env' → '.env (1)'. */
  export function keepBothName(name: string, taken: (candidate: string) => Promise<boolean>): Promise<string>;
  export class TransferQueue {
    constructor(deps: { sftp: SftpService; emit: SshServiceDeps['emit']; now?: () => number; concurrency?: number });
    copy(sender: WebContents, request: SftpCopyRequest): Promise<{ transferIds: string[] }>;
    resolve(sender: WebContents, request: { batchId: string; decision: ConflictDecisionWire; applyToRest: boolean }): void;
    cancel(sender: WebContents, request: { transferId: string }): void;
    retry(sender: WebContents, request: { transferId: string }): void;
    disposeFor(sender: WebContents): void;
  }
  ```

- [ ] Tests first with in-memory local and remote fakes (a `Map` file system whose streams can be slowed and
      broken): three run at once and the fourth is `queued`; a folder walk makes folders before their files, an
      existing target folder is reused, and a folder symlink is `skipped`, not walked; copying `/a` into `/a/b`
      is refused before any write; a clash pauses as `waiting` and emits one `sftp.conflict`; `skip`,
      `keep-both` and `replace` each do what spec D3 says, and `applyToRest` answers the batch's later clashes
      without asking (without it, each asks); the same name twice in one batch clashes the second time; every
      write goes to `name.wirebench-part` and is renamed at the end; a broken read stream fails the transfer,
      removes the part file and leaves an existing target intact; `cancel` mid-stream ends `cancelled` with no
      part file; `retry` starts over; a session closing fails its running and queued transfers; `disposeFor`
      cancels everything and emits nothing afterwards; progress events come at most four a second per
      transfer plus each state change; an upload keeps the local mode bits.
- [ ] `safe-name.test.ts`: `../x`, `a/b`, `a\\b`, `.`, `..`, `''` and a name with NUL are refused; `.hidden`,
      `a b` and `ünï` are kept; a remote entry named `../evil` downloaded into a temp folder is refused and
      nothing is written outside it.
- [ ] Implement with `stream.pipeline` and an `AbortController` per transfer; register `sftp.copy`,
      `sftp.resolve`, `sftp.cancel`, `sftp.retry`; dispose with the window and the workspace switch.
- [ ] Commit `feat(desktop): transfer queue with conflicts, cancel and retry`.

### Task 10: Local pane, drag and drop, transfers strip, conflict dialog

**Files:** create `apps/desktop/src/renderer/features/ssh/files/transfers-strip.tsx`, `transfers-store.ts`,
`conflict-dialog.tsx`; modify `file-pane.tsx`, `files-tab.tsx`, `file-menu.tsx`,
`apps/desktop/src/preload/build-api.ts` (expose `pathForFile(file: File): string` through
`webUtils.getPathForFile`); tests `apps/desktop/test/renderer/files-transfers.test.tsx`, `files-dnd.test.tsx`.

- [ ] Tests first: the left pane lists `sftp.localHome().home` with no session; dragging a selection onto the
      other pane (or a folder row in it) calls `sftp.copy` with that folder; a drop on the same pane does
      nothing; an OS drop on a remote pane sends the dropped paths; an OS drop on the local pane does nothing; the
      strip shows rows from `sftp.transfer`, Cancel calls `sftp.cancel`, Retry shows on a failed row, Clear done
      removes finished rows; the conflict dialog shows both sides' size and time, the "do this for the n other
      clashes" box appears only when more remain, and Escape answers Skip; closing the tab with running
      transfers asks first.
- [ ] Implement; "Copy to other pane" (`sftp.copyToOtherPane`) in the menu and as a command; the receiving pane
      refreshes when its batch finishes. Run `pnpm docs:commands`.
- [ ] Commit `feat(desktop): copy between panes with a transfers strip`.

## PR 5 — remote to remote (issue: SFTP 5/7)

### Task 11: Place picker and two remote sessions

**Files:** create `apps/desktop/src/renderer/features/ssh/files/place-picker.tsx`,
`apps/desktop/test/renderer/files-place-picker.test.tsx`; modify `file-pane.tsx`, `files-store.ts`,
`apps/desktop/test/transfers.test.ts`.

- [ ] Tests first: the picker lists This machine, then every host by group path and name, filterable; choosing
      a host opens a session for that pane (with its own trust prompt when needed) and closes the pane's
      previous session; both panes on the same host each hold their own session; a remote → remote copy
      between two fake sessions streams through main and honours conflicts and cancel; one session closing
      fails only its own transfers.
- [ ] Implement. Commit `feat(desktop): switch a Files pane to another host`.

## PR 6 — edit in the system editor (issue: SFTP 6/7)

### Task 12: Edit service in main

**Files:** create `apps/desktop/src/main/sftp-edit.ts`, `apps/desktop/test/sftp-edit.test.ts`; modify
`areas/sftp-channels.ts`, `ssh-window.ts`, the main start-up (the sweep).

**Interfaces:**

- Produces:

  ```ts
  export class SftpEditService {
    constructor(deps: {
      sftp: SftpService;
      emit: SshServiceDeps['emit'];
      /** userData/sftp-edit */
      root: string;
      /** shell.openPath: '' on success, else the OS's message. */
      openPath: (path: string) => Promise<string>;
      watch?: typeof import('node:fs').watch;
    });
    edit(sender: WebContents, request: { sessionId: string; path: string; confirmedLarge?: boolean }): Promise<{ editId: string }>;
    reply(sender: WebContents, request: { editId: string; decision: 'overwrite' | 'keep-remote' }): Promise<void>;
    end(sender: WebContents, request: { editId: string }): Promise<void>;
    disposeFor(sender: WebContents): Promise<void>;
  }
  /** Removes everything under `root`; once at start-up. */
  export function sweepEditCopies(root: string): Promise<void>;
  ```

- [ ] Tests first with a fake session and a controllable watcher: the copy lands in a fresh `0700` folder under
      `root`, named through `safeLocalName`; a change uploads once after 500 ms of quiet; a touch with the same
      content uploads nothing; a remote whose `size` or `mtime` changed emits `remote-changed` and waits;
      `overwrite` uploads, `keep-remote` stops watching and keeps the copy; a save during a running upload
      queues one more upload with the latest content and never runs two at once; `end`, the session closing
      and `disposeFor` stop the watcher and delete the folder; `sweepEditCopies` empties `root`; a file over
      50 MB is refused unless `confirmedLarge`.
- [ ] Implement; register `sftp.edit`, `sftp.editReply`, `sftp.endEdit`; sweep at start-up.
- [ ] Commit `feat(desktop): edit a remote file in the system editor`.

### Task 13: Editing banner and Open / Edit

**Files:** create `apps/desktop/src/renderer/features/ssh/files/edit-banner.tsx`,
`apps/desktop/test/renderer/files-edit.test.tsx`; modify `file-pane.tsx`, `file-menu.tsx`, `files-tab.tsx`.

- [ ] Tests first: Enter on a remote file or Open / Edit calls `sftp.edit` (asking first above 50 MB, then
      sending `confirmedLarge`); the banner counts open edits and shows each file's last state from
      `sftp.edit` events; `remote-changed` shows Overwrite and Keep remote inline; Stop editing calls
      `sftp.endEdit`; closing the tab ends every edit.
- [ ] Implement. Commit `feat(desktop): editing banner in Files`.

## PR 7 — docs, ADR, e2e (issue: SFTP 7/7)

### Task 14: ADR and docs

**Files:** create `docs/adr/0025-the-sftp-local-pane-reads-and-writes-any-local-path.md` (take the next free
number from `ls docs/adr` at the time); modify the "Hosts and terminals" docs page under `site/` (find it with
`grep -rl "hosts.yaml" site`) and the spec's status line.

- [ ] ADR: context (`DialogPicks` and project containment), decision (spec R5, scoped to `sftp.*`, gone with the
      area switch), consequences (a compromised renderer could upload a local file to a trusted host; what
      limits it: channel scope, the area switch, no other channel changes).
- [ ] Docs "Files": opening a Files tab, the two panes and switching hosts, copying and conflicts, cancel and
      retry, permissions, editing with upload on save, what is not supported (spec non-goals), the local access
      stance. Run `pnpm check:banned-terms`.
- [ ] Commit `docs: SFTP Files tab and the local access ADR`.

### Task 15: e2e

**Files:** create `e2e/specs/ssh-files.spec.ts`, reusing `ssh-terminal.spec.ts`'s fixture setup.

- [ ] With the fixture's SFTP root and a temp home: open Hosts, trust as in the terminal e2e, open Files from
      the host card; see the remote folder; New folder `up`; drag `a.txt` from the local pane into `up`; rename it
      `b.txt`; Permissions → `600`, the column reads `rw-------`; copy `b.txt` back to the local pane and check
      the bytes on disk; copy a 200 MB file and cancel it, the strip shows Cancelled and no `.wirebench-part`
      remains; open the terminal tab, press **Files**, and the Files tab is focused.
- [ ] Runs in CI only. Commit `test(e2e): SFTP Files tab`.

## Spec coverage

| Spec                                          | Tasks          |
| --------------------------------------------- | -------------- |
| R1 two panes, remote to remote                | 7, 10, 11      |
| R2 separate tab, own connection, cross links  | 6              |
| R3 system editor, upload on save              | 12, 13         |
| R4 conflicts per batch                        | 9, 10          |
| R5 whole-disk local pane, ADR                 | 5, 14          |
| R6 SFTP subsystem over the hop chain          | 1, 2           |
| D1 `dialChain`, `openSftp`, `SftpSession`     | 1, 2           |
| D2 `SftpService`, channels, events, ownership | 3, 4, 5        |
| D3 transfers                                  | 9, 10, 11      |
| D4 editing                                    | 12, 13         |
| D5 Files tab, panes, strip, dialogs, prefs    | 6, 7, 8, 10    |
| D6 commands                                   | 6, 8, 10       |
| D7 errors                                     | 2, 5, 9        |
| D8 jump hosts                                 | 1, 2           |
| D9 security                                   | 5, 9, 12, 14   |
| Testing (package, desktop, e2e)               | 1, 2, 5, 9, 15 |
| Docs                                          | 14             |
