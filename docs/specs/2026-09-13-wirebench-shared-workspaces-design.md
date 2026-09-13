# Spec: Wirebench shared workspaces (git-native collaboration)

- Status: approved 2026-09-13 with the §16 defaults; to be implemented by
  `docs/plans/2026-09-13-wirebench-shared-workspaces-plan.md`
- Date: 2026-09-13
- Builds on: `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md` (§3 stack, §8 commands, §10
  style, §12 boundaries all still bind), `docs/specs/2026-09-11-wirebench-workspaces-design.md` (the
  workspace layer this shares), `docs/specs/2026-09-13-unsaved-changes-across-sessions-design.md` (the
  per-file three-way merge this reuses), ADR-0003 (project folder format), ADR-0004 (secrets outside
  project files), ADR-0005 (renderer path safety), ADR-0006 (workspaces in app data)
- Decisions taken with the owner on 2026-09-13: collaboration is **user-selectable per workspace** between
  *asynchronous via git* and *real-time via Wirebench Server*; the **whole workspace** is the unit that is
  shared; the git backend is **a folder plus a built-in Sync control that uses the system `git`** (a plain
  synced folder still works without git); secrets stay **per member** in this version, shared-encrypted
  secrets are a follow-up; Wirebench Server signs users in with **OIDC only**; the first users are **small
  developer teams with git hosting**, so the git backend ships first; real-time means **live updates plus
  presence**, not co-editing; and the architecture is **one repository, two transports** — a shared
  workspace is a git repository whether the user's machine or the server runs git.
- Scope split: this spec covers the shared-workspace model, the format changes, the sync engine, the git
  and folder backends, the UI, and the client-side interface the server backend will implement. **Wirebench
  Server and the client's server backend are a second spec** that inherits everything here; §5.4 fixes the
  socket it plugs into.

## Assumptions I'm making

1. **No 1.2 has shipped.** `WORKSPACE_FORMAT_VERSION` can go from 2 to 3 in the next release without an
   intermediate step; 1.1.0 loaders already refuse a too-new manifest (`workspace-format-too-new`).
2. **The REST branch bumps only the project format.** `origin/claude/rest-support-spec-pgogjv` moves
   `FORMAT_VERSION` (project) to 3 and leaves the workspace format at 2, so the two changes are independent
   and can land in either order.
3. **Git is on every developer machine and every CI runner.** The app never bundles git; when it is absent
   the workspace still works as a folder and the Sync control explains what is missing.
4. **Workspaces stay in app data** (ADR-0006). The shared tree is either an app-managed clone inside the
   workspace's app-data directory or an external folder the user picked; in both cases the app-data
   directory remains the workspace's home for machine-local state.
5. **One window, one workspace** (workspaces spec §1, assumption 7) still holds; a shared workspace is
   opened, switched and closed exactly like a local one.
6. **The engine stays pure Node.** Nothing here adds an Electron import to `packages/engine`, because the
   server (spec 2) will run the same merge code.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Let a team work in one workspace. A workspace becomes *shared* by turning it into a git
repository (or by living in a folder a sync client replicates); members join by cloning it; every save is
a commit; Sync pulls, merges and pushes; conflicts are resolved in the app. Environments — today the one
thing that never leaves a machine — travel with the workspace. Wirebench Server, in spec 2, is the same
repository with the server running git, plus live updates, presence and sign-in.

**Why.** Teams exercise the same services against the same targets and keep re-typing each other's
requests and environments. Linking a project folder that lives in git (1.1.0) shares one project at a time
and leaves environments behind. The roadmap's "Teams and sign-in" section (`docs/roadmap.md`) lists
git-native teams as *S remaining* and a self-hosted server as *XL*; this design makes the second an
extension of the first instead of a separate product.

**Who.** A developer or QA team of two to twenty people that already has GitHub, GitLab, Azure DevOps,
Gitea or a synced drive; later, the enterprise team that wants sign-in, roles and an audit trail.

**User stories.**

- As a developer, I share my workspace to our GitLab group in one dialog and my teammate opens it from the
  URL; both of us see the same projects and environments.
- As a QA engineer, I change the *QA* environment's base URL; my teammate gets it on their next pull,
  without a chat message.
- As a team member, I open a request whose password ref is not on my machine; the field says so and lets
  me enter my own value, and the shared files do not change.
- As a non-git user, I never see a terminal: *Pull*, *Push* and a conflict list with *Keep mine* / *Keep
  theirs* are enough.
- As a team lead, I keep the workspace repository in our normal git hosting with our normal permissions
  and SSO; no new server to run.

**Non-goals (this spec).** Wirebench Server and its client backend (spec 2); sharing secret *values*;
sharing history; real-time co-editing; linked projects inside a shared workspace; a YAML-aware merge
driver; bundling a git binary; multi-window.

## 2. Concept model

- **Share kind.** Every workspace has one: `local` (today's workspace, nothing changes), `folder` (the
  shared tree is a folder some sync client replicates; no Sync control), `git` (a git repository; Sync
  control lights up when system git is found), `server` (spec 2). `folder` and `git` are the same layout;
  a `folder` workspace whose tree contains `.git` behaves as `git` whenever git is available.
- **Shared tree.** The workspace files that every member sees: `workspace.yaml`, `environments/`,
  `projects/<slug>/`. Byte-for-byte the format ADR-0003 and the workspaces spec describe, minus the
  per-machine fields §4.1 removes.
- **Machine-local state.** Everything that must not travel: which environment is active here, the
  unsaved-changes records, the share configuration itself (remote URL, branch, external path), secrets,
  history. It stays in the workspace's app-data directory, never in the tree.
- **Sync status.** One value per open shared workspace: `clean`, `ahead`, `behind`, `diverged`,
  `conflict`, `syncing`, `offline`, `error`, plus `lastSyncAt` and the ahead/behind counts.
- **Secret ref vs value.** Unchanged from ADR-0004: refs (`sec_…`) live in the tree and are the same for
  every member; values live in each member's keychain-backed store. A ref with no local value is a
  visible state, not a silent placeholder.

## 3. Behaviour

### 3.1 Lifecycle

- **Share this workspace…** (workspace menu, picker context menu) on a `local` workspace: choose *Git
  repository*; enter an optional remote URL and branch (default `main`). The app moves the shared tree
  into `<id>/tree/`, initialises the repository, writes `.gitattributes`, makes the first commit, and
  pushes if a remote was given. A workspace can be shared with no remote and get one later from the Sync
  settings. Choose *Synced folder* instead: pick a folder (native dialog); the app moves the tree there.
- **Join a shared workspace…** (picker): paste a git URL (and optional branch); the app clones into
  `<id>/tree/` where `<id>` is the manifest's ULID read after the clone (the clone lands in a temporary
  directory first, then is renamed once the id is known). *Use existing clone…* picks a folder that is
  already a checkout; *Use synced folder…* picks any folder that contains a `workspace.yaml`. Joining a
  workspace whose id is already present is refused (`workspace-already-present`) and the existing one is
  offered.
- **Open/switch/close** are unchanged; on open of a `git` workspace the app runs a fetch (§3.3) and
  restores unsaved changes on top as today.
- **Stop sharing** (Sync settings): moves the tree back to the app-data root, keeps the `.git` directory
  next to it for the user to delete, and sets the kind to `local`. Data is never deleted.
- **Remove from list** (picker) on a shared workspace deletes the app-data directory including a managed
  clone (trash, as today); an external folder is left untouched.

### 3.2 What is shared and what is not

| Travels in the tree | Stays on the machine |
| --- | --- |
| `workspace.yaml` (name, description, properties, disabled list, project list) | active environment (`local.yaml`) |
| `environments/*.yaml` including endpoint overrides | share configuration (`share.yaml`) |
| every internal project: interfaces, definitions, operations, requests, WSS config, attachments | unsaved records and drafts (`unsaved/`) |
| `.gitattributes` | secret values, history, preferences, UI state |

**Internal projects only.** *Link existing project folder…* is disabled in a shared workspace with the
message "Shared workspaces hold their projects inside the workspace; use *Move to workspace…* to copy it
in." *Move to workspace…* (project context menu) copies a project into a shared workspace, keeping ids
unless one already exists in the target, in which case the copy is re-identified (`reidentify.ts`).

### 3.3 Sync (git kind)

- **Commit on save.** Every successful save runs `add -A` + `commit` on the tree with a generated
  message (§4.4). If the repository has no `user.name`/`user.email`, the app asks once ("Commits need a
  name and email") and writes them to the repository's local config. With *Commit on save* off (Sync
  settings), saves stay uncommitted until *Commit…* is used with a message the user writes.
- **Fetch** on open, on demand (*Pull*, the badge's refresh), and on a per-workspace interval
  (*Auto-fetch every N seconds*, default 60, `0` = off). A failed fetch marks the workspace `offline` and
  backs the interval off to five minutes until one succeeds. Fetch never changes files; it only updates
  the ahead/behind counts.
- **Pull** = fetch + `merge --no-edit origin/<branch>`. With uncommitted changes in the tree (*Commit on
  save* off) Pull is disabled until they are committed. After a merge that changed files, projects that
  are clean are reloaded from disk without asking; a dirty project gets today's *Changed on disk* banner
  with Reload / Keep. Pulled workspace-level files (manifest, environments) are reloaded the same way.
- **Push** on demand, or automatically after every commit when *Push on save* is on. A rejected push
  (non-fast-forward) triggers one fetch + merge + retry; if that merge conflicts, the conflict flow takes
  over and the push waits.
- **Conflicts.** After a merge, `diff --name-only --diff-filter=U` lists the files. Each is shown with its
  entity name and project; *Keep mine* / *Keep theirs* run `checkout --ours|--theirs -- <path>` + `add`;
  *Open file* reveals it in the file manager for hand-editing; *Cancel* runs `merge --abort`. When no
  conflicted file remains, the app commits the merge and reloads. **While a merge is in conflict the app
  does not reload from disk**: a file with conflict markers does not parse, and a project with one
  unparsable request must not vanish. The in-memory model stays at its pre-merge state, the watchers'
  reloads are held for that workspace, conflicted entities carry a mark in the explorer and their editors
  are read-only; the reload happens once the merge is committed or aborted.
- **External git use is fine.** Anything the user does in the tree with the git CLI is picked up by the
  watchers (§5.2) and reflected in the status; the app never assumes it is the only writer.

### 3.4 Sync (folder kind)

No Sync control. The watchers reload external changes as for git; two members saving the same file race
on whatever the sync client does (usually last-write-wins with a conflicted copy the app ignores). The
guide says so plainly and recommends git for anything beyond a solo multi-machine setup.

### 3.5 Secrets in a shared workspace

`SecretField` asks `secrets.exists` for a set ref and shows **Not on this machine — Enter…** when it is
false. *Enter…* stores the typed value under the same ref through `secrets.replace`, so the tree is
untouched and the send works. A send with a missing value still fails with `secret-missing`; the Problem
now names the field. Nothing in this spec writes a secret value to the tree.

### 3.6 Everything else

Unchanged: editors, environments UI, history, search, preferences, the unsaved-changes recovery, autosave
(with autosave on, each autosave is a commit; the message says so).

## 4. Data model and storage

### 4.1 Workspace manifest `formatVersion: 3`

`workspace.yaml` loses its two per-machine fields:

```yaml
formatVersion: 3
id: 01J…            # ULID, identical on every member's machine
name: Payments team
description: …
createdAt: 2026-09-13T10:00:00Z
properties: { … }
disabled: [ … ]      # omitted when empty
projects:
  - { id: 01J…, slug: billing, source: internal }
```

- `activeEnvironmentId` moves to `local.yaml`. `writtenBy` is dropped: it changed with every build, the
  unsaved store already strips it before comparing, and in a repository it would be pure noise.
- In a shared workspace every project entry is `source: internal`; a `linked` entry makes the manifest
  invalid there (`share-linked-project-refused`) and valid in a local workspace as today.
- Loading a v2 manifest lifts `activeEnvironmentId` into `local.yaml` (if that file has none) and ignores
  `writtenBy`; the next save writes v3. A v3 manifest is refused by 1.1 with the existing
  `workspace-format-too-new`.

### 4.2 App-data directory of a workspace

```
<userData>/workspaces/<id>/
  workspace.yaml, environments/, projects/   # local kind only: the tree lives here, as today
  local.yaml                                  # { version: 1, activeEnvironmentId? }
  share.yaml                                  # shared kinds only; absent = local
  unsaved/                                    # as today
  tree/                                       # git/folder kinds with a managed clone
```

`share.yaml` (never inside the tree):

```yaml
version: 1
kind: git                     # git | folder | server
path: /Users/me/code/team-apis   # absent = managed tree/; only ever set from a native dialog
git:
  remote: git@gitlab.example.com:team/apis.git   # optional until set
  branch: main
  autoFetchSeconds: 60
  commitOnSave: true
  pushOnSave: true
```

The tree root is `share.path ?? <id>/tree` for shared kinds and `<id>` for `local`. Every path the
service builds from the tree root goes through the same containment check ADR-0005 applies to project
paths.

### 4.3 The tree of a git workspace

`.gitattributes`, written on share and on join if missing:

```
* text=auto eol=lf
*.yaml text
*.xml text
*.wsdl text
*.xsd text
projects/*/attachments/** -text
```

No `.gitignore` is needed: nothing machine-local is inside the tree. Definition caches (`definition/`)
are shared on purpose — they are byte-exact copies that make the project loadable offline.

### 4.4 Generated commit messages

From the changed paths, mapped to entities through the engine's path conventions:

- one entity: `Update GetWeather in Weather`, `Add environment QA`, `Delete request Ping in Billing`,
  `Update workspace properties`
- several: `Update 3 requests, 1 environment` with one path per line in the body
- autosave: same subject, `(autosave)` appended
- merge commits and conflict resolutions: git's own message

### 4.5 Sync status (wire)

```ts
type SyncStatusWire = {
  kind: 'local' | 'folder' | 'git' | 'server';
  gitAvailable: boolean;             // false → folder behaviour with an explanation
  state: 'clean' | 'ahead' | 'behind' | 'diverged' | 'conflict' | 'syncing' | 'offline' | 'error';
  ahead: number; behind: number;     // commits
  uncommitted: number;               // changed files when commitOnSave is off
  remote?: string; branch?: string;
  lastSyncAt?: string;               // ISO, last successful fetch or push
  error?: { code: string; message: string };
};
type SyncConflictWire = { path: string; projectId?: string; entity?: { kind: string; name: string } };
type SyncLogEntryWire = { id: string; subject: string; author: string; at: string };
```

## 5. Architecture

### 5.1 Main process

- **`SyncService`** (`apps/desktop/src/main/sync/sync-service.ts`), one per open shared workspace,
  owned by `WorkspaceService`. Holds the status, the timer, the operation queue (one git operation at a
  time per workspace; UI actions queue behind a running fetch), and the hooks the save path calls:
  `afterSave(projectId | 'workspace', changedPaths)`. Emits `sync.statusChanged`, `sync.pulled`,
  `sync.conflict`.
- **`SyncBackend`** (`main/sync/backend.ts`) is the interface every kind implements:

  ```ts
  interface SyncBackend {
    readonly kind: 'folder' | 'git' | 'server';
    probe(): Promise<SyncStatusWire>;                  // capability + current state, no network
    fetch(): Promise<SyncStatusWire>;
    merge(): Promise<{ conflicts: SyncConflictWire[]; changedPaths: string[] }>;
    commit(message: string): Promise<{ committed: boolean }>;
    push(): Promise<SyncStatusWire>;
    conflicts(): Promise<SyncConflictWire[]>;
    resolve(path: string, side: 'mine' | 'theirs'): Promise<void>;
    abortMerge(): Promise<void>;
    log(limit: number): Promise<SyncLogEntryWire[]>;
    subscribeRemote(onChange: () => void): () => void;  // git: no-op; server: socket events
  }
  ```

  `FolderBackend` implements `probe` and `log` (empty) and rejects the rest with `sync-not-supported`.
  `GitBackend` implements all of them over `GitCli`. `ServerBackend` is spec 2; a `FakeServerBackend`
  lives in tests so the contract suite (§11) already exercises the interface from the renderer down.
- **`GitCli`** (`main/sync/git-cli.ts`): finds git (§7), runs it with `execFile`, argument arrays, `cwd`
  pinned to the tree, `GIT_TERMINAL_PROMPT=0`, `GIT_ASKPASS=` (empty), `GIT_SSH_COMMAND="ssh -o
  BatchMode=yes"` unless the user's environment already sets one (so ssh can never block on a passphrase
  or host-key prompt either), `LC_ALL=C`, a 60 s timeout (clone
  and push: 10 min), and parses the handful of outputs the backend needs (`status --porcelain=v2`,
  `rev-list --left-right --count`, `diff --name-only --diff-filter=U`, `log --format=%H%x00%s%x00%an%x00%aI`).
  Remote URLs are validated before any call: `https://`, `ssh://`, `git@host:path` and `file://` are
  allowed; anything else, including `ext::` and values starting with `-`, is refused with
  `git-remote-refused`. Authentication failures are recognised from stderr and mapped to
  `git-auth-failed`; the app never prompts for git credentials.
- **Watchers.** The existing `project-watch.ts` keeps watching each project. A new `workspace-watch.ts`
  watches `workspace.yaml` and `environments/**` of every workspace (not only shared ones) and emits
  `workspace.changedOnDisk`, on which `WorkspaceService` reloads the manifest and environments if they
  parse and are not dirty, or shows the banner if they are. Both watchers ignore paths the sync service
  just wrote, with the same 2 s self-write TTL the project watcher uses, and both hold their reloads
  while the workspace's sync state is `conflict` (§3.3).
- **Save path.** `ProjectHost`'s save and `WorkspaceService`'s manifest/environment saves call
  `SyncService.afterSave` after `writeFileAtomic` succeeds. With *Commit on save* on, that commits (and
  pushes when *Push on save* is on) on a short debounce (500 ms) so a *Save All* is one commit.
- **Preferences.** `git.path` and `git.pathPickedByMain`, main-only exactly like `ssl.caBundlePath`
  (`MAIN_ONLY_SSL_KEYS` becomes a general main-only list); `git.detect` re-runs discovery, `git.locate`
  opens a native file dialog.

### 5.2 IPC

Channels (`shared/ipc.ts`, `defineChannel`), all workspace-scoped through the open workspace:

- `sync.status` → `SyncStatusWire`; `sync.pull`, `sync.push`, `sync.fetch` → `SyncStatusWire`;
  `sync.commit { message? }`; `sync.conflicts` → `SyncConflictWire[]`; `sync.resolve { path, side }`;
  `sync.abortMerge`; `sync.log { limit }`; `sync.updateSettings { autoFetchSeconds?, commitOnSave?,
  pushOnSave?, remote?, branch? }`; `sync.setIdentity { name, email }` (answers `git.identityNeeded`);
  `sync.revealTree` (file manager).
- `workspace.share { kind: 'git', remote?, branch? }`, `workspace.shareToFolder` (dialog in main),
  `workspace.join { remote, branch? }`, `workspace.joinFromFolder` (dialog), `workspace.stopSharing`,
  `project.moveToWorkspace { projectId, workspaceId }`.
- `git.detect`, `git.locate`.

Events (`defineEvent`): `sync.statusChanged`, `sync.pulled { projectIds, workspaceChanged, entityCount }`,
`sync.conflict { conflicts }`, `workspace.changedOnDisk`, `git.identityNeeded` (asks for name/email once).

### 5.3 Renderer

- `state/sync.ts`: status, conflicts, log, settings; subscribes to the events; exposes the actions.
- `features/sync/sync-badge.tsx` in the status bar next to the TLS badge: kind glyph, status word,
  relative last-sync time; click opens `sync-popover.tsx` (Pull / Push / Commit…, conflicts, last 20
  commits, settings, *Reveal tree*, *Stop sharing*).
- `features/sync/sync-banner.tsx` mounted beside `ChangedOnDiskBanner`: pulled-changes notice (with
  Reload/Keep only when something is dirty) and the conflict call-to-action.
- `features/sync/conflict-resolver.tsx`: modal list with Keep mine / Keep theirs / Open file / Cancel.
- `features/workspace/share-dialog.tsx`, `join-dialog.tsx`; picker entries and kind glyphs.
- `components/secret-field.tsx`: the *Not on this machine — Enter…* state.
- `features/preferences/sections/git.tsx`: detected path, *Locate…*, version.
- Commands (§8) registered like every other command, so they get shortcuts and palette entries.

### 5.4 The socket for Wirebench Server (spec 2)

Spec 2 adds `ServerBackend implements SyncBackend`: `fetch`/`merge`/`push` become one round trip that
posts changed files with the base commit id and receives either the new head (the server merged with the
engine's three-way merge and system git on a bare repository) or a conflict list for the same resolver;
`subscribeRemote` is a WebSocket carrying `commit` events (the client writes the received files into the
tree atomically, and the watchers do the rest) and `presence`. Sign-in (OIDC auth-code + PKCE in the
system browser, token in `safeStorage`), organisations, roles, and presence avatars are spec 2's UI.
Nothing in this spec is throw-away for it: the tree, `share.yaml` (`kind: server`, `server: { url,
workspaceId }`), the status model, the resolver, the banners and the contract tests are reused as-is.

## 6. Security and path safety (extends ADR-0005)

- All git execution and all network traffic stay in main. `git.path`, external tree paths and remotes
  come from native dialogs or validated text; the renderer never sends a path it typed.
- `execFile` with argument arrays; no shell; `GIT_TERMINAL_PROMPT=0` and an empty `GIT_ASKPASS` so git
  can never block on a prompt; system and global git config are honoured so proxies, SSH keys, credential
  helpers and corporate CAs keep working; `-c` overrides are limited to three: `core.autocrlf=false`,
  `merge.conflictstyle=merge`, and `core.hooksPath=<empty directory>`.
- Remote URL allow-list (§5.1); paths passed to git are always prefixed with `--` where git accepts it.
- The tree never contains `unsaved/`, `local.yaml`, `share.yaml`, secrets or history; the containment
  check refuses an external `share.path` that lies inside `<userData>`, so a share can never point at
  another workspace's app-data directory.
- A git repository can carry hooks; the `core.hooksPath` override above applies to every command the app
  issues, so a cloned repository cannot execute code on join, commit or merge.
- `secret-missing` and the *Not on this machine* state ensure a shared ref is never silently treated as
  set; nothing here adds a `secrets.get` channel.
- Auto-fetch is a network call the user initiated by sharing the workspace; it is disclosed in the Sync
  settings with its interval and can be turned off, meeting the roadmap's "opt-in per workspace, with
  visible status" principle. No other new network traffic exists in this spec.

## 7. Tech stack

- No new runtime dependency. Git is the system `git` located, in order, from `git.path` if set, then
  `PATH`, then the usual places (`/usr/bin/git`, `/opt/homebrew/bin/git`, `/usr/local/bin/git`,
  `%ProgramFiles%\Git\cmd\git.exe`, `%LocalAppData%\Programs\Git\cmd\git.exe`). Discovery runs
  `git --version` with a 5 s timeout; on macOS the Xcode shim without Command Line Tools exits non-zero
  and is treated as *not installed*, with the install hint in the Sync control.
- Minimum git 2.20; `init -b` is used when 2.28+ and replaced by `init` + `symbolic-ref` otherwise.
- Engine additions (`packages/engine/src/workspace/`): `local-state.ts`, `share.ts` (schemas),
  `commit-message.ts`, and the v3 migration. All pure.

## 8. Commands

`sync.pull`, `sync.push`, `sync.commit`, `sync.fetch`, `sync.resolveConflicts`, `sync.openSettings`,
`sync.revealTree`, `workspace.share`, `workspace.join`, `workspace.stopSharing`, `project.moveToWorkspace`.
Each is registered in the command registry like every existing command, so it appears in the palette and
the workspace or Sync menu; `sync.pull` and `sync.push` get default shortcuts chosen in the plan against
the registry's existing bindings.

## 9. Project structure (new or changed)

```
packages/engine/src/workspace/
  model.ts schema.ts serialize.ts migrate.ts   # v3
  local-state.ts share.ts commit-message.ts    # new
apps/desktop/src/main/sync/
  sync-service.ts backend.ts git-backend.ts folder-backend.ts git-cli.ts workspace-watch.ts
apps/desktop/src/main/ipc/sync.ts             # new; workspace.ts and preferences.ts gain channels
apps/desktop/src/main/{workspace-service,project-host,preferences}.ts   # hooks, tree root, git.path
apps/desktop/src/shared/{ipc,wire-types}.ts
apps/desktop/src/renderer/features/sync/…      # badge, popover, banner, resolver
apps/desktop/src/renderer/features/workspace/{share-dialog,join-dialog}.tsx
apps/desktop/src/renderer/components/secret-field.tsx
apps/desktop/src/renderer/features/preferences/sections/git.tsx
apps/desktop/src/renderer/state/sync.ts
e2e/helpers/git-remote.ts  e2e/specs/sync.spec.ts
docs/adr/0007-shared-workspaces-are-git-repositories.md  docs/collaborate.md
```

## 10. Code style

As the v1 spec §10. Two additions: every `GitCli` call site names the git subcommand in a string constant
so the allow-list of subcommands the app can run is one array; and every error surfaced to the user is a
`WirebenchError` with a code from §5.1/§6 and a hint the Problems panel can render.

## 11. Testing strategy

- **Engine unit:** v2→v3 migration (lifts `activeEnvironmentId`, drops `writtenBy`, refuses `linked` in
  a shared manifest), `local.yaml` and `share.yaml` schemas, commit-message generation table, tree-root
  resolution and containment.
- **Main unit:** `GitCli` discovery (fixture PATHs, the macOS shim case), URL allow-list, stderr → error
  code mapping; `GitBackend` against a temporary bare repository over `file://` — clone, commit on save
  (one commit per Save All), fetch counts, merge fast-forward, diverged, conflict + each resolution, abort,
  rejected push → retry, hooks disabled; `FolderBackend`; `SyncService` queueing, debounce, backoff,
  timer stop on close; watchers reload clean state and defer dirty state.
- **Backend contract suite:** one test file parameterised over `GitBackend`, `FolderBackend` and
  `FakeServerBackend`, asserting the interface's observable rules (status transitions, conflict lists,
  idempotent `resolve`, `abortMerge` restores the pre-merge tree).
- **Renderer unit:** badge states, popover actions call the right channels, resolver flows, secret-field
  missing state, dialogs validate input.
- **e2e (all three OSes; git required, so the suite fails rather than skips when it is missing):**
  share a local workspace → bare remote receives the commit; two profiles clone the same remote, A edits an
  environment and pushes, B pulls and sees it with no banner (clean) and with the banner (dirty); a
  conflict through the resolver both ways; secret *Not on this machine* → Enter → send succeeds; join
  from a URL and from an existing clone; stop sharing keeps the files. The temp profiles reuse
  `launchApp({ userDataDir })` and the `WIREBENCH_E2E_DIALOG_FOLDER` stub.
- **Checks:** `check:banned-terms` and `check:doc-paths` extend to the new docs; screenshots for the
  guide come from `sync.spec.ts`.

## 12. Boundaries

Extends the v1 spec §12.

- **Always:** run git and every network call in main; keep the tree free of machine-local files; keep
  secret values out of the tree; make every sync action visible in the status bar; keep the engine free
  of Electron imports.
- **Ask first:** bundling a git binary; any network endpoint beyond the user's git remote; any change to
  the auto-fetch default; adding a YAML-aware merge driver; allowing `linked` projects in shared
  workspaces; shared secret values.
- **Never:** prompt for git credentials inside the app; run git through a shell; execute repository
  hooks; store a token anywhere but `safeStorage`; write a secret value to the tree; push or fetch from
  a workspace the user did not share.

## 13. Success criteria (done when all are true)

1. A local workspace becomes a git workspace from one dialog; the remote receives a commit that contains
   exactly the shared tree and `.gitattributes`.
2. A second machine joins from the URL and shows the same projects and environments with the same ids.
3. A save on either machine is one commit with a readable generated message; a pull on the other applies
   it and reloads clean projects without a prompt.
4. A conflicting edit surfaces as a conflict with entity names and is resolved either way in the app,
   after which both machines converge.
5. A request whose secret ref has no local value shows *Not on this machine*, accepts a value, and sends;
   the tree is unchanged by that.
6. With git absent the workspace still opens as a folder and the Sync control says what to install.
7. `workspace.yaml` v3 contains no per-machine field; a 1.1.0 build refuses it with the existing message.
8. The unsaved-changes recovery still passes its suite with shared workspaces.
9. `pnpm check` passes on all three OSes, including the new e2e specs.
10. `docs/collaborate.md`, ADR-0007, the ADR-0006 note, `security.md` and the roadmap are updated.

## 14. Migration and compatibility

- Workspace format 2 → 3: read by 1.2, written on the next save; refused by 1.1.0. Nothing else changes
  shape, so a 1.1.0 project inside a shared workspace is read as today.
- Existing local workspaces gain `local.yaml` on first open; no user-visible change.
- A workspace linked project (1.1.0 feature) stays valid in local workspaces; *Move to workspace…* is the
  path into a shared one.
- Coordination with the REST branch: if REST lands first, this spec's engine changes rebase onto project
  format 3 with no overlap; if this lands first, REST's bump is unaffected because the two formats are
  versioned separately.

## 15. Risks

- **Line-level merges on YAML.** One file per entity keeps conflicts rare, but two edits to one request's
  envelope conflict at line level. Mitigation: the resolver; a YAML-aware driver is a listed follow-up.
- **Git edge cases on Windows** (paths, CRLF, long paths). Mitigation: `.gitattributes` + `-c
  core.autocrlf=false`, `core.longpaths` hint in the guide, Windows in the e2e matrix.
- **Credential failures look like outages.** Mitigation: `git-auth-failed` is distinct from `offline`,
  with a hint naming SSH keys and credential helpers; the guide has a per-host section.
- **Commit noise with autosave.** Mitigation: *Commit on save* and *Push on save* are per-workspace
  settings; autosave commits are marked; squashing is the user's git hosting's job.
- **Clone-then-rename on join** can leave a temporary directory on a crash. Mitigation: temporary clones
  live under `<userData>/workspaces/.joining/` and are removed at launch.
- **Repository hooks.** Mitigated by `core.hooksPath` (§6); the guide says the app never runs them.

## 16. Open questions (bold = proposed default)

1. *Push on save* default: **on** (the target user does not think in commits) — or off for quieter history?
2. Auto-fetch default interval: **60 s**, backoff to 5 min when offline.
3. Merge strategy: **merge, never rebase**; history readability is secondary to never rewriting a
   teammate's commit.
4. Commit identity when git has none: **ask once, write repo-local `user.name`/`user.email`**, rather
   than a Wirebench-wide identity preference (which would be the first identity concept in the app and
   belongs with spec 2).
5. `.gitattributes` marks `attachments/**` binary and everything else LF text: **yes**.
6. A `folder` workspace that gains a `.git` directory behaves as `git`: **yes, automatically**.
7. Minimum supported git: **2.20** (Debian 10 era), with the `init -b` fallback.
8. Whether *Move to workspace…* keeps ids when they do not collide: **yes** — so a project that moved from
   a local to a shared workspace keeps its history and secret refs.
