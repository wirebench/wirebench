# Wirebench Server: `server-sync` — design

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24 · Module: `server-sync` of
`docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Intent: `docs/intent/wirebench-server-teams.md`
- Builds on: `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md` (§3 lifecycle and sync
  behaviour, §4.2 app-data layout, §4.5 status wire, §5.1 `SyncBackend` and `SyncService`, §5.4 the
  socket, §6 path safety, §11 the backend contract suite), `docs/specs/2026-09-24-wirebench-server-host-design.md`
  (`RepoStore`, `withLock`, `GitCli` and `mergeFiles` in the engine), `…-identity-design.md` (`ServerClient`,
  accounts), `…-teams-access-design.md` (`requireWorkspaceRole`, `GET /workspaces`, workspace creation).
- Decision recorded here (2026-09-24): **the three-way merge runs on the client, the server stores
  commits.** §5.4 of the shared-workspaces spec sketched a server-side merge; the backend contract
  suite (`apps/desktop/test/sync/backend-contract.test.ts`) fixes `merge()` as an operation that
  leaves the client *ahead* until `push()`, so a pull must never publish local commits. A server-side
  merge would either publish them or need a dry-run merge endpoint that returns the same data a
  client-side merge computes from a diff. The engine's `mergeFiles` is the same code either way, which
  is what the owner asked for; the server needs no worktree and no merge endpoint.

## Assumptions I'm making

1. **No git on the client for a server workspace.** The tree is plain files; the client keeps a base
   snapshot and pending commits in app data (§4.2). This is what lets a viewer without git open a
   workspace, and it is why the contract suite's `FakeServerBackend` was written the way it was.
2. **One linear history per workspace, branch `main`.** No branches, no rewriting. A push whose parent
   is not the current head is rejected and the client merges first, exactly as a non-fast-forward
   push is handled for git today (`SyncService.pushNow`).
3. **Commits are attributed by the server to the signed-in user.** `setIdentity` is honoured locally
   for display (the contract requires it) but never trusted server-side.
4. **Files are text or base64.** The wire carries `encoding: 'utf8' | 'base64'`; the merge treats a
   base64 file changed on both sides as a conflict.
5. **A workspace snapshot fits in one 32 MiB response and one 32 MiB push** (host §3.2). Larger
   workspaces are refused with `sync-too-large`; chunking is a follow-up.
6. **`gitAvailable: true` means "sync works" for a server share.** `SyncService` and the badge key the
   auto-fetch timer and the actions on that flag; the name stays for wire compatibility and a comment
   says so.
7. **Polling, not push, in this slice.** `subscribeRemote` stays a no-op; the auto-fetch interval does
   the work. Live updates are the WebSocket follow-up in the roadmap.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** `ServerBackend implements SyncBackend`, backed by Wirebench Server over HTTP: probe, fetch,
merge, commit, push, conflicts, resolve, finish, abort, log, identity. Server side: the commit store on
the bare repository (git plumbing through `GitCli`), the snapshot, changes, commits and log endpoints
guarded by `requireWorkspaceRole`. Desktop side: *Share this workspace… → Wirebench Server*, *Open a team
workspace…*, `share.yaml` `kind: server`, the viewer experience (push refused with a reason), and the
sign-in and access errors surfaced through the existing Sync badge, popover and banners.

**Why.** This is the intent's success sentence made real: a non-git teammate signs in, opens a
workspace they were granted, sends requests, and cannot push as a viewer; an editor's saves reach the
team without a git host.

**Who.** Every team member; the `SyncService`, resolver and badge that already exist and must not
learn anything new about transports beyond one more backend.

**User stories.**

- As an editor, I share my local workspace to the *Payments QA* team; my teammates see it in *Open a team
  workspace…* and open it without installing git.
- As a viewer, I open the workspace, send requests with my own secret values, edit a request, and the
  badge tells me my edits stay on this machine.
- As an editor, my saves commit and push as they do with git; when a teammate pushed first, the app
  pulls, merges and retries; a conflict opens the same resolver.
- As a team admin, I promote the viewer to editor; on their next fetch the badge changes and their
  pending local commits push.
- As a signed-out user, the workspace still opens from its local files; the badge says *Sign in* and
  nothing syncs until I do.

**Non-goals (this module).** Live updates and presence; branches; sharing history; a YAML-aware merge;
partial or chunked snapshots; moving a workspace between git and server kinds; linked projects (still
refused in shared workspaces); secret values (still per member).

## 2. Concept model

- **Head.** The server's `refs/heads/main` commit id for a workspace; `null` before the first push.
- **Base.** The head the client's tree was last reconciled with; the client keeps that snapshot.
- **Pending commit.** A local commit not yet pushed: subject, time, and the changes relative to the
  previous committed snapshot. `ahead` is the number of pending commits.
- **Known head.** The head the last `fetch` reported; `behind` is the number of commits between base
  and known head, as the server reports it.
- **Merge state.** While a merge has unresolved conflicts: the conflicted paths, both sides, the
  pre-merge tree and the paths the merge wrote, persisted so a conflict survives a restart.

## 3. Behaviour

### 3.1 The backend, operation by operation

All network calls go through `ServerClient` (identity §5.3) with the account's token for the share's
`url`. Every operation maps errors as in §3.5.

- **`probe`.** Local only: `state` from merge state, `ahead`, `behind` (from the stored known head),
  `uncommitted` (tree vs last committed snapshot), `kind: 'server'`, `gitAvailable: true`,
  `remote: <url>`, `branch: 'main'`, plus the new `role` (teams-access §5.2) as last fetched.
- **`fetch`.** `GET /workspaces/:id/sync/head` → stores known head, `behind` and `role`; `lastSyncAt`.
  Unreachable → `sync-offline` (the `SyncService` backs off exactly as for git).
- **`merge`.** No-op when known head equals base. Refuses over uncommitted changes with
  `sync-uncommitted`. Otherwise `GET /workspaces/:id/sync/changes?from=<base>&to=<known>` → *theirs*
  as a file map over the base snapshot; *mine* is the last committed snapshot; `mergeFiles(base,
  theirs, mine)` from the engine. Modify/delete in either direction is a conflict (the fake's rule,
  now the real one). No conflict → write the merged tree atomically (self-write TTL so the watchers
  stay quiet), advance base to known, and if there were pending commits record a *Merge* commit so the
  client stays ahead; return `changedPaths`. Conflicts → write the non-conflicting merged files, keep
  *mine* in the conflicted paths, persist merge state, return the conflict list with entity names via
  `describeTreePath`.
- **`commit(message)`.** Diff tree vs last committed snapshot; nothing → `{ committed: false }`;
  otherwise append a pending commit and `{ committed: true }`.
- **`push`.** `POST /workspaces/:id/sync/commits` with `parent: base` and every pending commit in
  order. `201 { head }` → clear pending, base = known = head. `409 sync-push-rejected` → thrown as is;
  `SyncService.pushNow` already answers with pull + retry, and `isPushRejected` learns the new code.
  Viewer → `403 sync-forbidden` never happens because the client refuses first (§3.4); if it does
  (role changed since the last fetch), the error is surfaced and the role refreshed.
- **`conflicts`, `resolve`, `finishMerge`, `abortMerge`.** Exactly the fake's semantics, on the
  persisted merge state: `resolve` writes one side to the tree; `finishMerge` commits only the merge's
  paths into a pending *Merge* commit and advances base; `abortMerge` restores the pre-merge tree.
- **`log(limit)`.** Pending commits newest first, then `GET /workspaces/:id/sync/log?limit=` for the
  rest, cached with the last fetch so the popover does not hit the network on every open.
- **`changedPaths`.** Tree vs last committed snapshot as `TreeChange[]`.
- **`identity` / `setIdentity`.** Stored in `state.yaml`; default from the signed-in account's display
  name and email; used for the local log entries only.
- **`subscribeRemote`.** No-op.

### 3.2 Server endpoints (all under `/api/v1/workspaces/:workspaceId/sync`)

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /head` | viewer | `{ head: string \| null, commits: number, behind?: number, role }`. `behind` is counted from a `?from=<base>` query when given (`rev-list --count from..head`; unknown `from` → the total). `role` is the caller's effective role so the client refreshes it with every fetch. |
| `GET /snapshot?at=` | viewer | `{ head, files: [{ path, encoding, content }] }`. `at` defaults to head; unknown → `404 sync-unknown-commit`. Over the limit → `413 sync-too-large`. |
| `GET /changes?from=&to=` | viewer | `{ from, to, files: [{ path, encoding, content \| null }] }`: every path that differs, `null` for deleted. `from` empty = the empty tree. `from` not an ancestor of `to` → `400 sync-not-ancestor`. |
| `POST /commits` | editor | `{ parent: string \| null, commits: [{ subject, at, changes: [{ path, encoding, content \| null }] }] }` → `201 { head, ids }`. Runs inside `RepoStore.withLock`. `parent` must equal the current head → otherwise `409 sync-push-rejected { head }`. Each commit becomes one git commit authored by the caller, in order. An empty `commits` array → `400 invalid-request`. |
| `GET /log?limit=` | viewer | `[{ id, subject, author, at }]`, newest first, `limit` 1–200. |

Paths in `changes` are validated server-side with the engine's tree-path rules (relative,
normalised, no `..`, no absolute, no `.git` segment) and the shared-workspaces "stays on the machine"
list (`share.yaml`, `local.yaml`, `unsaved/`) → `400 sync-path-refused`. Path length ≤ 512, file
content ≤ 8 MiB each.

The server workspace id is the manifest ULID: creation passes `id` (teams-access §3.2, amended).

### 3.3 Server commit store

`packages/server/src/sync/commit-store.ts` works on the bare repository with `GitCli` and a private
index file (`GIT_INDEX_FILE` under `<dataDir>/tmp/<workspaceId>-<random>.idx`, removed afterwards):

- `head()`: `rev-parse --verify refs/heads/main`, `null` when unborn.
- `snapshot(at)`: `ls-tree -r -z` then `cat-file --batch` for blobs; UTF-8 validity decides `encoding`.
- `changes(from, to)`: `merge-base --is-ancestor` check, `diff-tree -r -z --name-status`, blobs via
  `cat-file --batch`.
- `appendCommits(parent, commits, author)`: `read-tree <parent-tree>` (or empty), for each commit
  `hash-object -w --stdin` per changed blob and `update-index --index-info` (adds and removals),
  `write-tree`, `commit-tree -p <parent> -m <subject>` with `GIT_AUTHOR_*`/`GIT_COMMITTER_*` set to
  the caller and `GIT_AUTHOR_DATE` to `at`, then a single `update-ref refs/heads/main <new> <old>` at
  the end, whose compare-and-swap is the second line of defence after `withLock`.
- `log(limit)`: `log --format=%H%x00%s%x00%an <%ae>%x00%aI -n <limit>`.

Every subcommand is a named constant; the allow-list is one array (shared-workspaces §10).

### 3.4 Desktop behaviour

- **Share to a server.** *Share this workspace…* gains a third choice, *Wirebench Server*, enabled
  when at least one account is signed in: pick the server (if several) and the team (from
  `team.list`), confirm the name (default the workspace name), default role (default *viewer*). Main
  creates the server workspace with the manifest's id, moves the tree into `<id>/tree/` (as the git
  share does), writes `share.yaml` `{ kind: server, server: { url, workspaceId, autoFetchSeconds: 60,
  commitOnSave: true, pushOnSave: true } }`, snapshots the tree as base with `head: null`, queues one
  pending commit "Share workspace" and pushes it. The first push failing leaves the workspace shared
  and *ahead*, exactly like a git share with an unreachable remote.
- **Open a team workspace.** A new picker entry beside *Join a shared workspace…*: lists
  `team.listWorkspaces` for every signed-in server (team, name, my role); choosing one downloads the
  snapshot into a temporary directory, verifies the manifest id equals the server id
  (`sync-workspace-id-mismatch` otherwise), renames it into `<id>/tree/`, writes `share.yaml` and the
  base snapshot, and opens it. An id already present → `workspace-already-present`, as for git.
- **Settings.** The Sync settings popover shows the server URL and the team instead of remote and
  branch; auto-fetch, commit on save and push on save behave as for git (`share.server` carries the
  same three fields; `settings()` in `WorkspaceService` reads `share.server ?? share.git`).
- **Viewer.** `status.role === 'viewer'`: the badge reads *Viewer*; *Push* and *Push on save* are
  disabled with "You have viewer access in this workspace; changes stay on this machine"; commit on
  save keeps working so the local log is meaningful; the `SyncService` skips the push step of
  `afterSave` when the last status says viewer. Editing is not blocked (the intent: a viewer sends
  with local edits).
- **Signed out or access removed.** Fetch returning `identity-unauthenticated` → status `error` with
  `sync-signed-out` and a *Sign in* action in the popover (opens the Sign in dialog for that server);
  `teams-workspace-not-found` → `sync-access-removed` ("You no longer have access; the files stay on
  this machine"). Neither loops: the auto-fetch timer pauses until the account changes.
- **Stop sharing.** Moves the tree back and deletes `server/` state; the server workspace is untouched
  (deleting it is the Team dialog's job).
- **Everything else** (reload after pull, dirty banners, conflict marks, held watchers) is unchanged:
  the `SyncService` and renderer do not know which backend they drive.

### 3.5 Error mapping

| Server or transport | Backend throws | Effect |
| --- | --- | --- |
| network failure, 5xx | `sync-offline` | `offline` state, back-off (as `git-offline`) |
| `409 sync-push-rejected` | `sync-push-rejected` | pull + retry once (as the git rejection) |
| `401 identity-unauthenticated` | `sync-signed-out` | error state, *Sign in* action |
| `404 teams-workspace-not-found`, `403 teams-forbidden` | `sync-access-removed` / `sync-forbidden` | error state; role refreshed |
| `413`, `sync-too-large` | `sync-too-large` | error state with the limit in the message |
| `sync-not-ancestor`, `sync-unknown-commit` | `sync-history-mismatch` | error state suggesting *Open a team workspace…* again (rejoin) |

`SyncService` generalises its two git-specific checks: `isPushRejected` accepts `sync-push-rejected`
and the offline check accepts `sync-offline`; nothing else in it changes.

## 4. Data model and storage

### 4.1 `share.yaml` (engine schema change, `workspaceShareSchema`)

```yaml
version: 1
kind: server
server:
  url: https://wirebench.example.com
  workspaceId: 01J8…            # equals workspace.yaml's id
  autoFetchSeconds: 60
  commitOnSave: true
  pushOnSave: true
```

`server` gains the three settings fields with the git defaults; `path` stays absent (a server tree
is always managed).

### 4.2 Client state `<userData>/workspaces/<id>/server/`

```
state.yaml        # { version: 1, base: { head: string|null }, knownHead?: string, behind?: number,
                  #   role?: 'viewer'|'editor'|'admin', identity?: { name, email }, lastSyncAt?: string }
base/             # the tree as of base.head (files only; no share.yaml, local.yaml, unsaved/)
pending/NNNN.yaml # { id, subject, at, changes: [{ path, encoding, content|null }] }, applied in order on base/
merge.yaml        # present only while a merge is in conflict: { conflicts: [path], mine: {...}, theirs: {...},
                  #   preMerge: {...}, mergePaths: [path] } — small, so it is one file
```

All writes are atomic (`writeFileAtomic`), the same helper the tree uses. Reading a corrupt state file
puts the status in `error` with `sync-state-corrupt` and the fix is *Open a team workspace…* again.

### 4.3 Server

No new tables. The bare repository holds everything; `workspaces` rows exist from teams-access.

### 4.4 Wire schemas

`packages/engine/src/server-api/sync.ts`: `syncFileSchema` (`path`, `encoding`, `content`),
`headResponseSchema`, `snapshotResponseSchema`, `changesResponseSchema`, `pushRequestSchema`,
`pushResponseSchema`, `logResponseSchema`. Shared by server routes and `ServerClient`.

## 5. Architecture

### 5.1 Server module

`packages/server/src/sync/` — `module.ts` (routes under the workspace prefix, `capabilities` gains
`"sync"` in `/api/v1/meta`), `commit-store.ts` (§3.3), `paths.ts` (path rules, shared with the engine
where they already exist), `routes/{head,snapshot,changes,commits,log}.ts`.

### 5.2 Engine

- `workspace/schema.ts`, `workspace/share.ts`: the `server` block's settings fields and defaults.
- `sync/three-way-merge.ts` (moved in server-host) gains the binary-conflict rule and the
  modify/delete-as-conflict option the fake implemented on top of it, so the desktop's
  `unsaved-store.ts` keeps its "drop" behaviour and the backend gets conflicts.
- `sync/tree-paths.ts`: the path rules of §3.2 as one function, used by the server and the client.

### 5.3 Desktop main

- `main/sync/server-backend.ts`: `ServerBackend` (§3.1), constructed by `create-backend.ts`'s
  `case 'server'` with `{ client: ServerClient, account, share, tree, stateDir }`; the placeholder goes.
- `main/sync/server-state.ts`: `state.yaml`, `base/`, `pending/`, `merge.yaml` I/O.
- `main/sync/sync-service.ts`: the two generalised checks; viewer skips push.
- `main/workspace-service.ts`: `shareToServer`, `joinFromServer`, `settings()` for server shares,
  stop sharing for server kind.
- IPC: `workspace.shareToServer { url, teamId, name, defaultRole? }`, `workspace.joinFromServer { url,
  workspaceId }`; `workspaceShareWireSchema` gains `server?: { url, teamName? }`.

### 5.4 Desktop renderer

`features/workspace/share-dialog.tsx` (third choice), `features/workspace/open-team-workspace-dialog.tsx`
(new), `features/sync/sync-badge.tsx` and `sync-panel.tsx` (viewer, sign-in and access states, server
settings), commands `workspace.openTeamWorkspace`.

## 6. Security

- Every sync route runs behind `requireWorkspaceRole`; the push route behind `editor`; the caller
  never names the author.
- Paths are validated twice: on the server before any git call, and on the client before writing a
  snapshot or a change to disk (ADR-0005 containment on the tree root).
- The commit store's `update-ref` compare-and-swap plus `withLock` prevent lost updates even if a
  second instance were ever started.
- No secret value can travel: the path rules refuse the machine-local files, the project schemas
  refuse plaintext keys (unchanged), and the secret-scan hold (`SecretHold`) still gates automatic
  commits.
- A viewer's local commits never leave the machine; the server refuses them too.
- Snapshots and changes are served only to callers with at least `viewer`; a `none` caller gets `404`.

## 7. Tech stack

Nothing new. `node:buffer` UTF-8 validation for the encoding decision.

## 8. Commands

Desktop: `workspace.openTeamWorkspace` ("Workspace: Open a team workspace…"), `workspace.share`
extended. Server: none.

## 9. Project structure (new or changed)

```
packages/server/src/sync/**                                   # §5.1
packages/server/test/unit/sync/{commit-store,paths}.test.ts   # against a temp bare repo (real git)
packages/server/test/integration/sync/**                       # routes with roles; push race under withLock
packages/engine/src/server-api/sync.ts
packages/engine/src/sync/{three-way-merge,tree-paths}.ts
packages/engine/src/workspace/{schema,share}.ts
apps/desktop/src/main/sync/{server-backend,server-state,create-backend,sync-service}.ts
apps/desktop/src/main/workspace-service.ts
apps/desktop/src/main/ipc/workspace.ts
apps/desktop/src/shared/{ipc,wire-types,commands,command-catalog}.ts
apps/desktop/src/renderer/features/workspace/{share-dialog,open-team-workspace-dialog}.tsx
apps/desktop/src/renderer/features/sync/{sync-badge,sync-panel}.tsx
apps/desktop/test/sync/backend-contract.test.ts               # third describe: the real ServerBackend
apps/desktop/test/sync/server-backend.test.ts
apps/desktop/test/sync/fake-server-backend.ts                 # stays, as the no-database contract run
e2e/helpers/fake-server.ts                                    # sync endpoints, in memory
e2e/specs/server-sync.spec.ts
docs/collaborate.md                                           # "Wirebench Server" section
docs-site/src/content/docs/…                                  # the user-facing page
```

## 10. Code style

As the earlier modules. Error codes are `sync-*`. The backend never touches `fetch` or headers: one
`ServerClient` method per route, one backend method per contract operation, and the state module is
the only writer under `server/`.

```ts
async push(): Promise<SyncStatusWire> {
  const state = await this.state.read();
  const pending = await this.state.pending();
  if (pending.length === 0) return this.probe();
  const result = await this.client.sync.pushCommits(this.share.server.workspaceId, {
    parent: state.base.head,
    commits: pending.map(({ subject, at, changes }) => ({ subject, at, changes })),
  });                                   // throws WirebenchError('sync-push-rejected', …, { details: { head } })
  await this.state.advanceBase(result.head, pending);
  return this.probe();
}
```

## 11. Testing strategy

- **Engine unit:** `mergeFiles` with the conflict options (text, binary, modify/delete both ways);
  `tree-paths` refusals; the `share.yaml` server block defaults.
- **Server unit (real git, temp bare repo):** `commit-store` round trips (`appendCommits` then
  `snapshot`, `changes`, `log`; unborn head; compare-and-swap failure; author from the caller;
  `at` preserved); path refusals.
- **Server integration (PostgreSQL):** every route with viewer, editor, admin and none; a viewer's
  push → 403; `parent` mismatch → 409 with the head; two concurrent pushes serialise under `withLock`
  and the second gets 409; `413` on an oversized push; `capabilities` contains `sync`.
- **Backend contract suite:** a third `describe` runs `defineContract` against two real
  `ServerBackend`s over one in-process server (`buildServer` with all modules and the test database),
  skipped without `WIREBENCH_SERVER_TEST_DATABASE_URL`; the fake stays as the always-on run. This is the
  proof the interface is honoured — the same assertions as git.
- **Desktop unit:** `server-state` I/O and corruption; `ServerBackend` error mapping table (§3.5) over
  a stub client; `SyncService` viewer skip and the generalised checks; `create-backend` server case;
  share and open-team-workspace flows in `WorkspaceService` with a stub client (id mismatch, already
  present); renderer: share dialog third choice, open dialog, badge and panel states.
- **e2e (fake server, all three OSes, no git required for this spec):** sign in, share a workspace to
  a team, a second profile opens it as a viewer, edits, sees *Viewer*, cannot push; the fake server
  promotes the profile to editor; after fetch the badge changes and push succeeds; a conflict via the
  fake's history opens the resolver, both resolutions; sign out mid-session shows *Sign in*.
- **Manual (owner):** the whole loop against the container image and a real IdP before the release
  that ships it; recorded in the PR.

## 12. Boundaries

Extends the earlier modules' §12.

- **Always:** keep `SyncService` and the renderer transport-agnostic; validate paths on both ends;
  write client state atomically; keep the contract suite green for git, fake and server; refuse a
  viewer's push on the client and on the server.
- **Ask first:** chunked snapshots; a server-side merge; branches; live updates; sharing history;
  any change to the conflict semantics the contract fixes; moving a workspace between kinds.
- **Never:** run git on the client for a server workspace; publish local commits during a pull;
  trust a client-supplied author; write a machine-local file into a snapshot or commit; delete a
  repository; block editing for a viewer.

## 13. Success criteria (done when all are true)

1. The backend contract suite passes for `GitBackend`, `FakeServerBackend` and `ServerBackend`
   against a real server.
2. A workspace shared to a team from one profile opens in another profile without git installed, and
   both profiles see each other's pushes after a fetch.
3. A viewer edits and sends but sees *Viewer* and cannot push, on the client and on the server (`403`);
   promotion to editor takes effect on the next fetch and the pending commits push.
4. A rejected push pulls, merges and retries; a conflict goes through the existing resolver both ways
   and the result pushes.
5. Sign-out and removed access show the specified states without looping requests.
6. `docs/collaborate.md` and the docs site describe sharing to and opening from Wirebench Server,
   including the viewer behaviour and the "one instance" deployment note.
7. `WIREBENCH_SKIP_PERF=1 pnpm check` is green and the e2e spec passes on all three OSes.
8. Issue #74's first-slice boxes are ticked, with presence, SAML, SCIM and audit moved to follow-up
   issues.

## 14. Migration and compatibility

`workspaceShareSchema`'s `server` block gains optional fields with defaults; no version bump.
`create-backend.ts` stops returning the placeholder for `server` shares; no shipped workspace has one.
`WORKSPACE_FORMAT_VERSION` is unchanged: the tree format is the git tree format.

## 15. Risks

- **Merge parity with git.** The contract suite is the guard; any divergence surfaces there first.
- **Large workspaces.** Attachments could exceed the limit. Mitigation: `sync-too-large` names the
  size; chunking is a listed follow-up.
- **Polling cost.** Sixty-second fetches per open workspace are one small GET; acceptable for a team.
- **Two writers on the tree.** A user editing files while a merge writes them: the same self-write TTL
  and held-watcher rules the git backend relies on apply unchanged.

## 16. Open questions (bold = proposed default)

1. Snapshot format: **JSON with base64 for binary** (a tar stream is a follow-up if size bites).
2. Fetch interval default for server shares: **60 s**, as git.
3. Viewer commit-on-save: **on**, so the local log and unsaved recovery work; push disabled.
4. Server `capabilities` name: **`sync`**.
