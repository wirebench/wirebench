# Wirebench Server: `server-sync` — design

Issue: #74 · Date: 2026-09-24 · Status: approved by the owner on 2026-09-24; revised 2026-09-25 against the
merged `server-host` (#156), `identity` (#157) and `teams-access` (#158) code, with four owner decisions
(see *Revision 2026-09-25*) · Module: `server-sync` of `docs/specs/2026-09-24-wirebench-server-capability-map.md`

- Intent: `docs/intent/wirebench-server-teams.md`
- Builds on:
  - `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md`: §3 lifecycle and sync behaviour, §4.2
    app-data layout, §4.5 status wire, §5.1 `SyncBackend` and `SyncService`, §5.4 the socket, §6 path
    safety, §11 the backend contract suite.
  - `docs/specs/2026-09-24-wirebench-server-host-design.md`: `RepoStore`, `withLock`, `GitCli` and
    `mergeFiles` in the engine.
  - `…-identity-design.md`: `ServerClient` and accounts.
  - `…-teams-access-design.md`: `requireWorkspaceRole`, `GET /workspaces`, workspace creation and deletion.
- Decision recorded here (2026-09-24): **the three-way merge runs on the client, and the server stores
  commits.**
  - §5.4 of the shared-workspaces spec sketched a server-side merge. The backend contract suite
    (`apps/desktop/test/sync/backend-contract.test.ts`) fixes `merge()` as an operation that leaves the
    client *ahead* until `push()`, so a pull must never publish local commits.
  - A server-side merge would either publish them, or need a dry-run merge endpoint that returns the
    same data a client-side merge computes from a diff.
  - The engine's `mergeFiles` is the same code either way, which is what the owner asked for. The server
    needs no worktree and no merge endpoint.
  - ADR-0012 records this decision. It amends ADR-0008's server bullet, the capability map's
    `server-sync` row, and the host spec's two mentions of server-side merge worktrees.

## Revision 2026-09-25

This spec was approved before the three modules it builds on were written. The merged code settled
names, signatures and ownership that the spec had guessed. Four owner decisions (O1–O4) and the rulings
below bring it in line. Every later section already reflects them.

| # | What changed | Why |
| --- | --- | --- |
| O1 | **Empty server workspaces are hidden until shared.** *Open a team workspace…* lists only server workspaces with a head. *Share this workspace… → Wirebench Server* can target an existing empty server workspace the caller can edit. The local workspace then **adopts** the server's id and name (§3.4). | Owner, 2026-09-25. The Team dialog's *New workspace…* (teams-access) creates workspaces with no manifest and no commits, which the open flow cannot use. |
| O2 | **Sharing again reconnects and merges.** Sharing a workspace whose id already exists on the server, with content, as editor or admin: the push is rejected, the normal pull merges over an empty base, and the push retries (§3.4). A viewer is told to open the server copy instead. | Owner, 2026-09-25. *Stop sharing* keeps the server copy, so re-sharing otherwise deadlocks on `409 teams-workspace-exists` or `workspace-already-present`. |
| O3 | **The share dialog offers the default roles *No access*, *Viewer* and *Editor*,** defaulting to *Viewer*, the same three as the Team dialog. | Owner, 2026-09-25. |
| O4 | **The real-server contract run lives in the server package** (`packages/server/test/integration/sync/backend-contract.test.ts`). It imports the shared contract definition and the desktop's `ServerBackend` source. There is no new dependency, and it runs in the existing `server-integration` CI job. | Owner, 2026-09-25. The desktop package has no server dependency or database. |
| R1 | **Git plumbing goes on a second, server-only allow-list** (§3.3). `GitCli` built with `{ plumbing: true }` accepts ten plumbing subcommands. `run()` gains `input`, a per-call `env` limited to named variables, a Buffer stdout and a per-call `maxBuffer`. The desktop's `GitCli` and allow-list are unchanged. | `GIT_SUBCOMMANDS` (`packages/engine/src/sync/git-cli.ts`) has none of the plumbing, `run()` has no stdin or env, and stdout is decoded as UTF-8. |
| R2 | **Guards and author.** GET routes use `requireWorkspaceRole(ctx.db, 'viewer')`, the push uses `requireWorkspaceRole(ctx.db, 'editor')`, and each declares the `teamWorkspaceParamsSchema` params. The role comes from `request.workspaceAccess`. The author is looked up with `findUserById`. | These are the merged signatures. `request.caller` has no display name. |
| R3 | **A push rejection carries no head.** It answers `409 sync-push-rejected` with no body detail, and the retry path fetches. | `toProblem` and `ServerClient.call` both drop `details`. Changing the problem shape would affect every module. |
| R4 | **Error mapping is completed** (§3.5): `server-unreachable`, `internal`, `server-bad-response` ≥ 500, `request-too-large`, `account-signed-out`, `identity-user-disabled` and `invalid-request`. | These are the real codes on the client. |
| R5 | **Size limits come from `bodyLimitMb`** (default 32, `WIREBENCH_SERVER_BODY_LIMIT_MB`) for both the push and the snapshot. The per-file limit of 8 MiB is a constant. Large calls get a longer per-call timeout in `ServerClient`. | One setting for the operator. `ServerClient` has one 15 s timeout for every call. |
| R6 | **Polling pauses and resumes** (§3.4). `SyncService` learns the stop-polling codes and `resume()`. `WorkspaceService` resumes on `AccountService.onChange`, and awaits `AccountService.ready` before the first server call at launch. | Today the fetch timer always re-arms, and accounts load fire-and-forget at launch. |
| R7 | **The `SyncService` changes are named exactly** (§5.3). This covers `isPushRejected`, the offline check, the state-keeping codes, the viewer skip in `commitThenMaybePush` and `pushWaitingCommits`, a manual push refused locally, and a `SyncSettings` type in place of `GitShareSettings`. | The spec said "one skip point" and "nothing else changes". The code has three push starts and a git-typed settings dependency. |
| R8 | **Desktop wiring follows the merged layout.** Share and join live in `workspace-share.ts`. `create-backend.ts` takes a `server` option, and `WorkspaceServiceDeps` gains it. Share reuses the `initialCommitMessage` path. Join stages under `.joining/`. Workspace creation calls `ServerClient.createWorkspace` from main, reusing `withToken`. | The merged code already has these seams. |
| R9 | **Merge options.** `mergeFiles` gains only `{ modifyDelete: 'conflict' }`. No binary rule is needed, because the merge is whole-file. `writtenBy` handling is unchanged, for parity with the git backend. The fake backend reports `gitAvailable: true`. | Checked against `three-way-merge.ts` and the fake. |
| R10 | **`share.yaml` validation.** `server.workspaceId` must be a ULID, `path` is refused for `kind: server`, and `url` is stored normalised. A manifest id that is not a ULID is re-identified to a new ULID when shared, the same way as O1. | The server only accepts ULIDs. |
| R11 | **Server robustness.** Covers four areas: <ul><li>**Races with delete:** the push re-checks `repos.exists` inside the lock, and a read that finds no repository answers `404`.</li><li>**Shutdown:** `RepoStore.drain()` is awaited in `close()`.</li><li>**Hooks:** a test plants real hooks and shows they never run.</li><li>**Input and cleanup:** commit ids are checked against a hash pattern before any git call, tree paths are validated in the handler, and leftover `tmp/*.idx` files are swept at start-up.</li></ul> | These are server-host carry-overs, and holes the merged code made reachable. |
| R12 | **Client robustness.** The server backend skips `tree/.git` and anything outside the tree items. Share refuses a leftover `tree/.git`, as the git share does. Share and open check `GET /meta` for the `sync` capability. | A leftover `.git` from a stopped git share would otherwise fail the first push. An older server would answer a bare `404`. |
| R13 | **Tests and e2e follow the merged helpers.** A sync harness seeds workspaces backed by a repository and uses a hermetic `ctx.git`. The e2e fake server gains ULID ids, honours `id` on create, and adds the sync routes, a `capabilities` option and control methods. | `seedWorkspace` inserts no repository, `ctx.git` reads the developer's gitconfig, and the fake has no sync routes. |
| R14 | **Already built, now referenced rather than specified.** <ul><li>`syncStatusWireSchema.role`.</li><li>`GET /workspaces` and `team.listWorkspaces`.</li><li>Workspace creation with an id, and workspace deletion.</li><li>The `RepoStore` staging carry-overs.</li><li>The guard and the capability table.</li><li>`withToken`, `normalizeServerUrl` and `team.list`.</li></ul> | teams-access and identity. |

## Assumptions I'm making

1. **No git on the client for a server workspace.** The tree is plain files, and the client keeps a base
   snapshot and pending commits in app data (§4.2). This is what lets a viewer without git open a
   workspace, and it is why the contract suite's `FakeServerBackend` was written the way it was.
2. **One linear history per workspace, on branch `main`.** There are no branches and no rewriting. A
   push whose parent is not the current head is rejected, and the client merges first, exactly as a
   non-fast-forward push is handled for git today (`SyncService.pushNow`).
3. **The server attributes commits to the signed-in user.** `setIdentity` is honoured locally for
   display, because the contract requires it, but it is never trusted server-side.
4. **Files are text or base64.** The wire carries `encoding: 'utf8' | 'base64'`. The merge is whole-file,
   so a file changed differently on both sides is a conflict whatever its encoding.
5. **A workspace snapshot fits in one response, and a push in one request, within the server's
   `bodyLimitMb`** (default 32 MiB). Larger ones are refused with `sync-too-large`; chunking is a
   follow-up.
6. **`gitAvailable: true` means "sync works" for a server share.** `SyncService` and the badge key the
   auto-fetch timer and the actions on that flag. The name stays for wire compatibility, and a comment
   says so. The fake backend follows the same rule (R9).
7. **Polling, not push, in this slice.** `subscribeRemote` stays a no-op, and the auto-fetch interval does
   the work. Live updates are the WebSocket follow-up in the roadmap.

---

## 1. Objective

**What.** `ServerBackend implements SyncBackend`, backed by Wirebench Server over HTTP: probe, fetch,
merge, commit, push, conflicts, resolve, finish, abort, log and identity.
- **Server side:** the commit store on the bare repository (git plumbing through a plumbing-enabled
  `GitCli`), plus the head, snapshot, changes, commits and log endpoints, guarded by
  `requireWorkspaceRole`.
- **Desktop side:**
  - *Share this workspace… → Wirebench Server*, into a new server workspace or an empty one;
  - *Open a team workspace…*;
  - `share.yaml` `kind: server`;
  - the viewer experience, where a push is refused with a reason;
  - sign-in and access errors, surfaced through the existing Sync badge, popover and banners.

**Why.** This makes the intent's success sentence real. A teammate who doesn't use git signs in, opens a
workspace they were granted and sends requests, and as a viewer cannot push. An editor's saves reach the
team without a git host.

**Who.** Every team member, and the `SyncService`, resolver and badge that already exist. Those must
learn nothing new about transports beyond one more backend and the small changes in §5.3.

**User stories.**

- As an editor, I share my local workspace to the *Payments QA* team. My teammates see it in *Open a team
  workspace…* and open it without installing git.
- As a team admin, I create an empty *Staging* workspace in Manage teams. An editor shares their local
  workspace into it, and from then on it appears in everyone's *Open a team workspace…*.
- As a viewer, I open the workspace, send requests with my own secret values and edit a request. The
  badge tells me my edits stay on this machine.
- As an editor, my saves commit and push as they do with git. When a teammate pushed first, the app
  pulls, merges and retries, and a conflict opens the same resolver.
- As a team admin, I promote the viewer to editor. On their next fetch the badge changes, and their
  pending local commits push.
- As a signed-out user, the workspace still opens from its local files. The badge says *Sign in*,
  nothing syncs, and nothing polls until I sign in again.
- As an editor who stopped sharing and later shares again, my local copy reconnects to the server copy
  through a normal merge.

**Non-goals (this module).**
- Live updates and presence.
- Branches.
- Sharing history.
- A YAML-aware merge.
- Partial or chunked snapshots.
- Moving a workspace between the git and server kinds.
- Linked projects, which shared workspaces still refuse.
- Secret values, which stay per member.
- Deleting a server workspace from *Stop sharing*: that stays the Team dialog's job.

## 2. Concept model

- **Head.** The server's `refs/heads/main` commit id for a workspace; `null` before the first push. A
  server workspace with a `null` head is *empty*.
- **Base.** The head the client's tree was last reconciled with. The client keeps that snapshot.
- **Pending commit.** A local commit not yet pushed: a subject, a time, and the changes relative to the
  previous committed snapshot. `ahead` is the number of pending commits.
- **Known head.** The head the last `fetch` reported. `behind` is the number of commits between the base
  and the known head, as the server reports it.
- **Merge state.** While a merge has unresolved conflicts: the conflicted paths, both sides, the
  pre-merge tree and the paths the merge wrote. It is persisted so a conflict survives a restart.
- **Adoption.** Rewriting a local workspace's id (and, for O1, its name) to match a server workspace,
  before its first share (§3.4).

## 3. Behaviour

### 3.1 The backend, operation by operation

All network calls go through `ServerClient` (identity §5.3) with the account's token for the share's
`url`, obtained through teams-access's `withToken` (`apps/desktop/src/main/ipc/team.ts`). That function is
lifted into a module both can import, and it is not copied. Every operation maps errors as in §3.5.

- **`probe`.** Local only. It reports:
  - `state` from the merge state;
  - `ahead`;
  - `behind`, from the stored known head;
  - `uncommitted`: the tree against the last committed snapshot, skipping `.git` and anything outside
    the tree items (R12);
  - `kind: 'server'`, `gitAvailable: true`, `remote: <url>` and `branch: 'main'`;
  - `role`, as last fetched, into the existing `syncStatusWireSchema.role`.
- **`fetch`.** Calls `GET /workspaces/:id/sync/head?from=<base>`, then stores the known head, `behind`,
  `role` and `lastSyncAt`. An unreachable server gives `sync-offline`, and the `SyncService` backs off
  exactly as for git.
- **`merge`.**
  - It is a no-op when the known head equals the base.
  - It refuses over uncommitted changes, with `sync-uncommitted`.
  - Otherwise it calls `GET /workspaces/:id/sync/changes?from=<base>&to=<known>`, which gives *theirs* as
    a file map over the base snapshot. *Mine* is the last committed snapshot. It then runs
    `mergeFiles(base, theirs, mine, { modifyDelete: 'conflict' })` from the engine, so a modify/delete in
    either direction is a conflict.
  - With no conflict, it:
    1. writes the merged tree atomically, with the self-write TTL so the watchers stay quiet;
    2. advances the base to the known head;
    3. records a *Merge* commit if there were pending commits, so the client stays ahead;
    4. returns `changedPaths`.
  - With conflicts, it writes the non-conflicting merged files, keeps *mine* in the conflicted paths,
    persists the merge state, and returns the conflict list with entity names from `describeTreePath`.
  - A base of `null` merges against the empty tree. That is how reconnecting (O2) resolves.
- **`commit(message)`.** Diffs the tree against the last committed snapshot. With nothing to commit it
  returns `{ committed: false }`. Otherwise it appends a pending commit and returns `{ committed: true }`.
- **`push`.**
  - It calls `POST /workspaces/:id/sync/commits` with `parent: base` and every pending commit, in order.
  - `201 { head, ids }` clears the pending commits and sets base = known = head.
  - `409 sync-push-rejected` is thrown as is. `SyncService.pushNow` already answers with pull and retry,
    and the pull fetches the new head (R3).
  - When the last status says viewer, the backend is never asked to push (§3.4). If the server still
    answers `403 teams-forbidden` because the role changed since the last fetch, the error is surfaced
    as `sync-forbidden` and the role refreshed.
- **`conflicts`, `resolve`, `finishMerge` and `abortMerge`** have exactly the fake's semantics, on the
  persisted merge state:
  - `resolve` writes one side to the tree;
  - `finishMerge` commits only the merge's paths into a pending *Merge* commit and advances the base;
  - `abortMerge` restores the pre-merge tree.
- **`log(limit)`.** Pending commits newest first, then `GET /workspaces/:id/sync/log?limit=` for the rest.
  The result is cached with the last fetch, so the popover does not hit the network on every open.
- **`changedPaths`.** The tree against the last committed snapshot, as `TreeChange[]`.
- **`identity` / `setIdentity`.** Stored in `state.yaml`. It defaults to the signed-in account's display
  name and email, and is used for the local log entries only.
- **`subscribeRemote`.** A no-op.

### 3.2 Server endpoints (all under `/api/v1/workspaces/:workspaceId/sync`)

Every route declares `params: jsonSchema(teamWorkspaceParamsSchema, { io: 'input' })` and a guard. Reads
use `requireWorkspaceRole(ctx.db, 'viewer')`, and the push uses `requireWorkspaceRole(ctx.db, 'editor')`.
The guard answers `404 teams-workspace-not-found` for a caller with no role, and `403 teams-forbidden`
for one whose role is too low. Every commit id in a query or body must match `^[0-9a-f]{40}$` or
`^[0-9a-f]{64}$` in the request schema, so it is checked before any git call.

| Method and path | Role | Purpose |
| --- | --- | --- |
| `GET /head?from=` | viewer | Returns `{ head: string \| null, commits: number, behind?: number, role }`. `behind` counts from `from` when it is given (`rev-list --count from..head`); an unknown `from` counts the total. `role` is `request.workspaceAccess.role`, so the client refreshes it on every fetch. |
| `GET /snapshot?at=` | viewer | Returns `{ head, files: [{ path, encoding, content }] }`. `at` defaults to the head; an unknown commit answers `404 sync-unknown-commit`. When the total content exceeds `bodyLimitMb`, it answers `413 sync-too-large`. |
| `GET /changes?from=&to=` | viewer | Returns `{ from, to, files: [{ path, encoding, content \| null }] }`: every path that differs, with `null` for a deleted file. An empty `from` means the empty tree. A `from` that is not an ancestor of `to` answers `400 sync-not-ancestor`. |
| `POST /commits` | editor | Takes `{ parent: string \| null, commits: [{ subject, at, changes: [{ path, encoding, content \| null }] }] }` and returns `201 { head, ids }`. <ul><li>Runs inside `RepoStore.withLock`, and first re-checks `repos.exists(id)`: a missing repository answers `404 teams-workspace-not-found` (R11).</li><li>`parent` must equal the current head; otherwise it answers `409 sync-push-rejected`, with no head in the body (R3).</li><li>Each commit becomes one git commit authored by the caller, in order.</li><li>An empty `commits` array answers `400 invalid-request`. A body over `bodyLimitMb` is refused by Fastify with `413 request-too-large`.</li></ul> |
| `GET /log?limit=` | viewer | Returns `[{ id, subject, author, at }]`, newest first, with `limit` from 1 to 200. |

Some checks run in the handler, after Fastify's schema check, because JSON Schema cannot carry them:
- Paths in `changes` go through the engine's `assertTreePath`: relative, normalised, no `..`, not
  absolute, no `.git` segment.
- The shared-workspaces "stays on the machine" list (`share.yaml`, `local.yaml`, `unsaved/`) is refused.
- `base64` content must decode, and `utf8` content must be valid UTF-8.

A violation answers `400 sync-path-refused` or `400 invalid-request`. Paths may be at most 512 characters
and each file's content at most 8 MiB.

A read that reaches a repository missing because of a concurrent delete answers `404
teams-workspace-not-found`, not a 500 (R11).

The sync module adds `sync` to `/api/v1/meta` `capabilities` with `ctx.meta.addCapability`.

### 3.3 Server commit store

`packages/server/src/sync/commit-store.ts` works on the bare repository. It uses a `GitCli` built with
`{ plumbing: true }` and a private index file: `GIT_INDEX_FILE` under
`<dataDir>/tmp/<workspaceId>-<random>.idx`, removed in a `finally`. Leftover `tmp/*.idx` files are
swept by the sync module at start-up.

- `head()`: `rev-parse --verify refs/heads/main`, or `null` when the branch is unborn.
- `snapshot(at)`: `ls-tree -r -z`, then `cat-file --batch` for the blobs, with Buffer stdout. UTF-8
  validity decides the `encoding`.
- `changes(from, to)`: a `merge-base --is-ancestor` check, then `diff-tree -r -z --name-status`, with blobs
  through `cat-file --batch`.
- `appendCommits(parent, commits, author)`:
  1. `read-tree <parent-tree>`, or `read-tree --empty` when `parent` is `null`.
  2. For each commit:
     - `hash-object -w --stdin` for each changed blob (stdin `input`);
     - `update-index --index-info` for the adds and removals;
     - `write-tree`;
     - `commit-tree -p <parent> -m <subject>`, with `GIT_AUTHOR_NAME/EMAIL/DATE` and
       `GIT_COMMITTER_NAME/EMAIL/DATE` set through the per-call `env`. The name and email are the
       caller's, from `findUserById`, and the author date is `at`.
  3. At the end, a single `update-ref refs/heads/main <new> <old>`, where `<old>` is `""` for an unborn
     head. Its compare-and-swap is the second line of defence after `withLock`.
- `log(limit)`: `log --format=%H%x00%s%x00%an <%ae>%x00%aI -n <limit>`.

**Plumbing allow-list (R1).** `packages/engine/src/sync/git-cli.ts` gains `GIT_PLUMBING_SUBCOMMANDS`:
`ls-tree`, `cat-file`, `merge-base`, `diff-tree`, `read-tree`, `hash-object`, `update-index`,
`write-tree`, `commit-tree` and `update-ref`. A `GitCli` accepts them only when it is constructed with
`{ plumbing: true }`; the desktop never does, and its `GIT_SUBCOMMANDS` is unchanged. `run(cwd, args,
options)` gains:
- `input?: string | Buffer`, written to stdin;
- `env?: Partial<Record<GitCallEnv, string>>`, where `GitCallEnv` is exactly the seven variables above.
  Any other key is refused.
- `stdout?: 'utf8' | 'buffer'`, defaulting to `'utf8'`;
- `maxBuffer?: number`, defaulting to today's 16 MiB. The commit store passes `bodyLimitMb` plus a
  margin.

The `Runner` type changes to match. Every subcommand is a named constant, and each allow-list is one
array (shared-workspaces §10). The hooks guard, `-c core.hooksPath=` on every call plus the repository
config, is unchanged, and a test now proves it against real hooks (§11).

**Shutdown (R11).** `RepoStore.drain()` refuses new `withLock` calls with `server-shutting-down` and
awaits every queue. `close()` in `serve.ts` awaits it before `db.close()`, completing host spec §3.7.

### 3.4 Desktop behaviour

- **Capability check (R12).** The share and open flows first call `GET /meta` on the server. Without
  `sync` in `capabilities`, they refuse with `sync-not-supported-by-server` ("This server is too old to
  sync workspaces").
- **Share to a server.** *Share this workspace…* gains a third choice, *Wirebench Server*, enabled when
  at least one account is signed in. It follows the shape of the existing git share, including its
  rollback (`workspace-share.ts`):
  1. Pick the server (when there are several) and the team (from `team.list`).
  2. Choose where to share:
     - **New workspace** (default): confirm the name, which defaults to the workspace name, and the
       default role (*No access*, *Viewer* or *Editor*; default *Viewer*, O3).
     - **An existing empty workspace** (O1): lists the team's workspaces with a `null` head that the
       caller can edit, found through `team.listWorkspaces` and a `GET /sync/head` per row, in parallel.
  3. Refuse early:
     - with `workspace-git-leftover` when `tree/.git` exists (R12), as the git share does;
     - with `workspace-linked-project` when a project is linked, as for git.
  4. **Adopt when needed.** Adopt the server workspace's id and name when an existing empty workspace was
     chosen. Adopt a new ULID when the manifest id is not a ULID (R10).
     - Adoption renames `<userData>/workspaces/<old>/` to `<new>/`, rewrites `workspace.yaml`'s `id`
       (and `name`), and moves the old id's last-opened entries in the workspace state to the new id.
     - Secrets and history are keyed by project id, so they are untouched.
     - It runs while the workspace is closed, like the tree move, and is undone by the same rollback.
  5. Move the tree into `<id>/tree/`, as the git share does, and write `share.yaml`:
     `{ kind: server, server: { url, workspaceId, autoFetchSeconds: 60, commitOnSave: true, pushOnSave:
     true } }`.
  6. Create the server workspace for a **new** share, by calling `ServerClient.createWorkspace(url,
     token, teamId, { id, name, defaultRole })` from main (the `team.createWorkspace` IPC does not pass
     `id`). On a server failure, roll the local steps back (R8).
     - `409 teams-workspace-name-taken` → the dialog error "A workspace with that name already exists
       in this team".
     - `409 teams-workspace-exists` → the reconnect case below.
  7. Write an empty base (`head: null`), and open the workspace with `initialCommitMessage: "Share
     workspace <name>"`. The existing initial commit and the catch-up push do the rest (R8).
  - If the first push fails, the workspace stays shared and *ahead*, exactly like a git share with an
    unreachable remote.
- **Reconnect (O2).** The workspace id already exists on the server:
  - **The caller is an editor or admin and the head is not `null`.** Skip creation, keep the empty base,
    and let the catch-up push run. It is rejected (`parent: null`), so `pushNow` pulls: the merge runs
    over the empty base, identical files merge cleanly, and different ones conflict in the resolver.
    After that the push retries. No new code is needed beyond skipping creation.
  - **The head is `null`.** It is a plain share without creation.
  - **The caller is a viewer.** Refuse with `sync-reconnect-viewer`: "You have viewer access to the
    server copy. Remove this local copy, then open it with *Open a team workspace…*."
  - **The caller has no access** (the head answers `404`). Refuse with `sync-workspace-exists-elsewhere`:
    "A workspace with this id exists on the server and you have no access to it."
- **Open a team workspace.** A new picker entry beside *Join a shared workspace…*.
  - It lists `team.listWorkspaces` for every signed-in server (team, name, my role), keeping only rows
    whose `GET /sync/head` reports a head (O1; empty workspaces are hidden).
  - Choosing one:
    1. downloads the snapshot into `<userData>/workspaces/.joining/<ulid>/`, the staging directory the git
       join uses, which is swept at launch;
    2. checks that the manifest id equals the server id, refusing with `sync-workspace-id-mismatch`
       otherwise (`requireWorkspaceId`);
    3. renames it into `<id>/tree/`;
    4. writes `share.yaml` and the base snapshot, and opens it.
  - An id already present locally → `workspace-already-present` (`alreadyPresent`), as for git.
- **Settings.** The Sync settings popover shows the server URL and the team instead of the remote and the
  branch. Auto-fetch, commit on save and push on save behave as for git: `share.server` carries the same
  three fields, and `settings()` reads `share.server ?? share.git` as a `SyncSettings`.
  `updateSyncSettings` accepts `kind: 'server'` and refuses `remote` and `branch` for it.
- **Viewer.** When `status.role === 'viewer'`:
  - the badge reads *Viewer*;
  - *Push* and *Push on save* are disabled with "You have viewer access in this workspace; changes stay
    on this machine";
  - commit on save keeps working, so the local log is meaningful;
  - `SyncService` skips the push in `commitThenMaybePush` and in the start-up `pushWaitingCommits`, and a
    manual `push()` answers `sync-forbidden` without a network call.

  Editing is not blocked: in the intent, a viewer sends with local edits.
- **Signed out or access removed (R6).**
  - No token for the URL → `sync-signed-out`, with no network call.
  - A fetch returning `identity-unauthenticated` → `sync-signed-out`, and the account is marked signed
    out, as teams-access's `withToken` does.
  - `identity-user-disabled` → `sync-account-disabled`.
  - `teams-workspace-not-found` → `sync-access-removed` ("You no longer have access; the files stay on
    this machine").

  All four put the status in `error` with an action in the popover: *Sign in* opens the Sign in dialog
  for that server. They are **stop-polling codes**: the fetch timer does not re-arm for them.
  `WorkspaceService` calls `SyncService.resume()` for the open server workspace when
  `AccountService.onChange` reports that its account changed.

  At launch, `WorkspaceService` awaits `AccountService.ready` before the first server call, so a
  reopened workspace does not show *Sign in* by mistake.
- **Stop sharing.** Moves the tree back and deletes the `server/` state. The server workspace is
  untouched; deleting it is the Team dialog's job. Sharing again later reconnects (O2).
- **Everything else is unchanged:** reload after pull, dirty banners, conflict marks and held watchers.
  The `SyncService` and the renderer do not know which backend they drive.

### 3.5 Error mapping

| Server or transport (client-side code) | Backend throws | Effect |
| --- | --- | --- |
| `server-unreachable`, `internal`, `server-bad-response` with status ≥ 500 | `sync-offline` | `offline` state, back-off (as `git-offline`) |
| `409 sync-push-rejected` | `sync-push-rejected` | pull and retry once, as for the git rejection; state kept |
| `account-signed-out` (no token, no call), `401 identity-unauthenticated` | `sync-signed-out` | error state, *Sign in* action; stop polling |
| `403 identity-user-disabled` | `sync-account-disabled` | error state; stop polling |
| `404 teams-workspace-not-found` | `sync-access-removed` | error state; stop polling |
| `403 teams-forbidden` | `sync-forbidden` | state kept; role refreshed; the popover shows the reason |
| `413 request-too-large`, `413 sync-too-large` | `sync-too-large` | state kept; the message names `bodyLimitMb` |
| `sync-not-ancestor`, `sync-unknown-commit` | `sync-history-mismatch` | error state suggesting *Open a team workspace…* again (rejoin) |
| `400 invalid-request`, `sync-path-refused` | the same code | error state with the server's message |

`SyncService` changes in `apps/desktop/src/main/sync/sync-service.ts`:
- `isPushRejected` accepts `sync-push-rejected`.
- The offline check in `recordError` accepts `sync-offline`.
- `STATE_KEEPING_CODES` gains `sync-push-rejected`, `sync-forbidden` and `sync-too-large`.
- The stop-polling set is `sync-signed-out`, `sync-account-disabled` and `sync-access-removed`, with
  `resume()`.

The viewer skip (§3.4) and the `SyncSettings` type (§5.3) are the only other changes.

## 4. Data model and storage

### 4.1 `share.yaml` (engine schema change, `workspaceShareSchema`)

```yaml
version: 1
kind: server
server:
  url: https://wirebench.example.com   # stored normalised (normalizeServerUrl)
  workspaceId: 01J8…                   # a ULID; equals workspace.yaml's id
  autoFetchSeconds: 60
  commitOnSave: true
  pushOnSave: true
```

- `server` gains the three settings fields, with the git defaults.
- `workspaceId` is validated with `TEAMS_ID_PATTERN`.
- A refine refuses `path` for `kind: server`, since a server tree is always managed.

### 4.2 Client state `<userData>/workspaces/<id>/server/`

```
state.yaml        # { version: 1, base: { head: string|null }, knownHead?: string, behind?: number,
                  #   role?: 'viewer'|'editor'|'admin', identity?: { name, email }, lastSyncAt?: string }
base/             # the tree as of base.head (files only; no share.yaml, local.yaml, unsaved/, .git)
pending/NNNN.yaml # { id, subject, at, changes: [{ path, encoding, content|null }] }, applied in order on base/
merge.yaml        # present only while a merge is in conflict: { conflicts: [path], mine: {...}, theirs: {...},
                  #   preMerge: {...}, mergePaths: [path] } — small, so it is one file
```

- All writes are atomic, through `writeFileAtomic`, the same helper the tree uses.
- A corrupt state file puts the status in `error` with `sync-state-corrupt`. The fix is *Open a team
  workspace…* again.
- Adoption (§3.4) renames the whole `<id>/` directory, so this state moves with it.

### 4.3 Server

No new tables and no migration. The bare repository holds everything, and the `workspaces` rows exist
from teams-access.

### 4.4 Wire schemas

`packages/engine/src/server-api/sync.ts` holds `syncFileSchema` (`path`, `encoding`, `content`),
`syncCommitIdSchema` (the hash pattern), `headQuerySchema`, `headResponseSchema`, `snapshotQuerySchema`,
`snapshotResponseSchema`, `changesQuerySchema`, `changesResponseSchema`, `pushRequestSchema`,
`pushResponseSchema`, `logQuerySchema` and `logResponseSchema`. The server routes and `ServerClient` share
them. They are plain zod, with no refines or transforms, because routes turn them into JSON Schema
(ADR-0009).

## 5. Architecture

### 5.1 Server module

`packages/server/src/sync/` contains:
- `module.ts`: `syncModule()`, appended to `BUILTIN_MODULES`. It has no `migrationsDir`, adds the `sync`
  capability, and sweeps `tmp/*.idx` on start.
- `commit-store.ts` (§3.3).
- `errors.ts`: the `sync-*` problems.
- `routes/{head,snapshot,changes,commits,log}.ts`.

The path rules are the engine's `assertTreePath`, so the server has no path module of its own.
`packages/server/src/repos/repo-store.ts` gains `drain()`, and `serve.ts` awaits it in `close()`.

### 5.2 Engine

- `sync/git-cli.ts`: the plumbing allow-list and the `run()` options (§3.3).
- `workspace/schema.ts`, `workspace/share.ts`: the `server` block's settings fields, defaults, ULID and
  `path` refinement, and the `SyncSettings` type (`autoFetchSeconds`, `commitOnSave`, `pushOnSave`).
- `sync/three-way-merge.ts`: `mergeFiles` gains an optional fourth argument, `{ modifyDelete?: 'drop' |
  'conflict' }`, defaulting to `'drop'` so `unsaved-store.ts` keeps its behaviour. There is no binary
  rule, because the merge is whole-file (R9).
- `sync/tree-paths.ts`: `assertTreePath`, the path rules of §3.2 as one function, used by the server and
  the client.
- `server-api/sync.ts` (§4.4).

### 5.3 Desktop main

- `main/sync/server-backend.ts`: `ServerBackend` (§3.1). It and every module it imports stay free of
  `electron`, because the server package's contract run imports it (O4).
- `main/sync/server-state.ts`: I/O for `state.yaml`, `base/`, `pending/` and `merge.yaml`. It is the only
  writer under `server/`.
- `main/sync/create-backend.ts`: `CreateSyncBackendOptions` gains `server?: { client: ServerClient;
  accounts: Pick<AccountService, 'tokenFor' | 'markSignedOut'> }`, and `case 'server'` builds a
  `ServerBackend` with `stateDir: <dir>/server`. The `FolderBackend` placeholder goes.
- `main/sync/sync-service.ts`: the changes in §3.5, the viewer skip, and `SyncServiceDeps.settings: () =>
  SyncSettings`.
- `main/server-token.ts`: `withToken`, lifted from `ipc/team.ts`, which now imports it.
- `main/server-client.ts`: the sync methods (`syncHead`, `syncSnapshot`, `syncChanges`, `pushCommits`,
  `syncLog`) and `meta`. `Call` gains an optional `timeoutMs`, which snapshots and pushes set to 120 s.
- `main/account-service.ts`: `ready: Promise<void>`, resolved when `load()` finishes.
- `main/workspace-share.ts`: `shareToServer`, `joinFromServer` and `adoptWorkspaceId`, plus the server
  branch of `stopSharing`. `ShareDeps` gains the `server` dependency.
- `main/workspace-service.ts`:
  - delegates to `workspace-share.ts`;
  - `WorkspaceServiceDeps` gains `server`;
  - `startSync` reads `share.server ?? share.git`, and `updateSyncSettings` accepts server shares;
  - `shareWire` maps `share.server`;
  - resumes on `accounts.onChange`, and awaits `accounts.ready` before the first server call.
- `main/index.ts`: passes `{ client: serverClient, accounts: accountService }` into `workspaceService`.
- IPC:
  - `workspace.shareToServer { url, teamId, target: { kind: 'new', name, defaultRole? } | { kind:
    'existing', workspaceId } }`;
  - `workspace.joinFromServer { url, workspaceId }`;
  - `workspace.serverTargets { url, teamId }` → the empty workspaces the caller can edit;
  - `workspace.teamWorkspaces` → the non-empty workspaces across signed-in servers, for the open dialog.
  - `workspaceShareWireSchema` gains `server?: { url, teamName? }`.

### 5.4 Desktop renderer

- `features/workspace/share-dialog.tsx`: the third choice, with *New* or *Existing empty workspace* and
  the three-way default role.
- `features/workspace/open-team-workspace-dialog.tsx`: new.
- `features/sync/sync-badge.tsx` and `sync-panel.tsx`: the viewer, sign-in, disabled-account and
  access-removed states, and the server settings instead of remote and branch.
- The command `workspace.openTeamWorkspace`.
- Renderer modules import only types from `shared/wire-types.ts` (the CSP rule), so role labels come from
  `features/team/roles.ts`.

## 6. Security

- Every sync route runs behind `requireWorkspaceRole(ctx.db, …)`: the push behind `editor`, the reads
  behind `viewer`. The caller never names the author.
- Paths are validated twice: on the server, in the handler, before any git call; and on the client,
  before writing a snapshot or a change to disk (ADR-0005 containment on the tree root).
- Commit ids are checked against a hash pattern before they reach git, so nothing in a query can become a
  git option.
- Plumbing subcommands are reachable only through a server-constructed `GitCli`, and the per-call `env`
  accepts only the seven named variables. The desktop's allow-list does not grow.
- The commit store's `update-ref` compare-and-swap, plus `withLock`, prevent lost updates even if a second
  instance were ever started. The push re-checks that the repository exists inside the lock.
- Repository hooks never run: `core.hooksPath` is emptied on every call, and a test plants real hooks to
  prove it.
- No secret value can travel:
  - the path rules refuse the machine-local files;
  - the project schemas refuse plaintext keys (unchanged);
  - the secret-scan hold (`SecretHold`) still gates automatic commits.
- A viewer's local commits never leave the machine, and the server refuses them too.
- Snapshots and changes are served only to callers with at least `viewer`. A caller with no role gets
  `404`.
- The token stays in main: `ServerBackend` gets it through `withToken`, and nothing crosses to the
  renderer.

## 7. Tech stack

Nothing new. `node:buffer` UTF-8 validation decides the encoding.

## 8. Commands

- Desktop: `workspace.openTeamWorkspace` ("Workspace: Open a team workspace…"), and `workspace.share`
  extended. Run `pnpm docs:commands` afterwards.
- Server: none.

## 9. Project structure (new or changed)

```
packages/engine/src/sync/{git-cli,three-way-merge,tree-paths}.ts
packages/engine/src/workspace/{schema,share}.ts
packages/engine/src/server-api/sync.ts
packages/server/src/sync/**                                    # §5.1
packages/server/src/repos/repo-store.ts                        # drain()
packages/server/src/{serve,modules}.ts
packages/server/test/unit/sync/{commit-store,hooks}.test.ts    # real git, temp bare repo
packages/server/test/unit/git-cli-plumbing.test.ts             # allow-lists stay separate
packages/server/test/integration/sync/**                       # routes with roles, races, limits
packages/server/test/integration/sync/backend-contract.test.ts # the real ServerBackend (O4)
packages/server/test/helpers/sync.ts                           # repo-backed workspaces, hermetic ctx.git
packages/server/tsconfig.test.json                             # includes the imported desktop files
apps/desktop/src/main/sync/{server-backend,server-state,create-backend,sync-service}.ts
apps/desktop/src/main/{server-client,server-token,account-service,workspace-share,workspace-service,index}.ts
apps/desktop/src/main/ipc/{workspace,team}.ts
apps/desktop/src/shared/{ipc,wire-types,commands,command-catalog}.ts
apps/desktop/src/renderer/features/workspace/{share-dialog,open-team-workspace-dialog}.tsx
apps/desktop/src/renderer/features/sync/{sync-badge,sync-panel}.tsx
apps/desktop/test/sync/backend-contract.ts                     # defineContract, shared (O4)
apps/desktop/test/sync/backend-contract.test.ts                # git and fake runs
apps/desktop/test/sync/{server-backend,server-state}.test.ts
apps/desktop/test/sync/fake-server-backend.ts                  # gitAvailable: true
e2e/helpers/fake-server.ts                                     # sync routes, ULIDs, control methods
e2e/specs/server-sync.spec.ts
docs/adr/0012-server-sync-merges-on-the-client.md
docs/adr/0008-shared-workspaces-are-git-repositories.md        # server bullet amended
docs/specs/2026-09-24-wirebench-server-{capability-map,host-design}.md  # merge mentions amended
docs/collaborate.md                                            # "Share with Wirebench Server", troubleshooting rows
docs-site/src/content/docs/guides/shared-workspaces.mdx
```

## 10. Code style

The same as the earlier modules. Error codes are `sync-*`, one function each in
`packages/server/src/sync/errors.ts`. The backend never touches `fetch` or headers: there is one
`ServerClient` method per route and one backend method per contract operation, and the state module is
the only writer under `server/`.

```ts
async push(): Promise<SyncStatusWire> {
  const state = await this.state.read();
  const pending = await this.state.pending();
  if (pending.length === 0) return this.probe();
  const result = await this.call((url, token) =>
    this.client.pushCommits(url, token, this.share.server.workspaceId, {
      parent: state.base.head,
      commits: pending.map(({ subject, at, changes }) => ({ subject, at, changes })),
    }),
  );                                  // a 409 rejection surfaces as WirebenchError('sync-push-rejected')
  await this.state.advanceBase(result.head, pending);
  return this.probe();
}
```

`this.call` is `withToken`, plus the §3.5 mapping.

## 11. Testing strategy

- **Engine unit:**
  - `mergeFiles` with `modifyDelete: 'conflict'` both ways, the default `'drop'` unchanged, and base64
    content changed on both sides;
  - `assertTreePath` refusals;
  - the `share.yaml` server block: defaults, a ULID refusal and a `path` refusal;
  - `GitCli`: plumbing is refused without `{ plumbing: true }`, an `env` key outside the seven is refused,
    `input` reaches stdin, and Buffer stdout is binary-safe.
- **Server unit (real git, temp bare repo):**
  - `commit-store` round trips: `appendCommits`, then `snapshot`, `changes` and `log`;
  - an unborn head, a compare-and-swap failure, the author from the caller, `at` preserved, and binary
    files;
  - leftover index files swept;
  - **hooks:** executable `hooks/reference-transaction` and `hooks/post-update` planted in the bare
    repository never run during `appendCommits`;
  - `RepoStore.drain`: a running holder finishes before the pool closes, and a later `withLock` is
    refused.
- **Server integration (PostgreSQL, `helpers/sync.ts`):**
  - every route with viewer, editor, admin and a stranger (404);
  - a viewer's push → 403; a `parent` mismatch → 409 with no head;
  - two concurrent pushes serialise under `withLock`, and the second gets 409;
  - a push racing a workspace delete → 404, and a read after a delete → 404, never 500;
  - an oversized push → `413 request-too-large`, and an oversized snapshot → `413 sync-too-large`;
  - a commit id with a leading `-` → 400 before git runs;
  - `sync-path-refused` for `.git/…`, `share.yaml` and `../x`;
  - `capabilities` contains `sync`.
- **Backend contract suite (O4):**
  - `defineContract` moves to `apps/desktop/test/sync/backend-contract.ts`. The desktop's `.test.ts` runs
    it for `GitBackend` and `FakeServerBackend`, which is always on.
  - `packages/server/test/integration/sync/backend-contract.test.ts` runs it against two real
    `ServerBackend`s. They share one in-process server (all modules, the test database) through a
    `ServerClient` whose `send` is an adapter over `app.inject`.
  - The fixture seeds a team, two users and a repository-backed workspace, and reproduces the shared
    initial commit with a push and a join.
  - It is skipped without `WIREBENCH_SERVER_TEST_DATABASE_URL`, and CI's `server-integration` job runs it.
  - This is the proof the interface is honoured: the same assertions as git.
- **Desktop unit:**
  - `server-state` I/O and corruption;
  - the `ServerBackend` error mapping table (§3.5) over a stub client;
  - in `SyncService`: the viewer skip in both push starts, the manual push refusal, stop-polling and
    `resume()`, and the new state-keeping codes;
  - the `create-backend` server case;
  - `AccountService.ready`;
  - in `workspace-share`, with a stub client:
    - a new share, a share into an existing empty workspace (adoption: directory, manifest id and name,
      workspace state), and adoption of a manifest id that is not a ULID;
    - rollback on a server failure;
    - reconnect as editor (a rejected push, then a merge over the empty base with one conflict), and
      refused as viewer or stranger;
    - the leftover `.git` refusal, the capability refusal, the id mismatch, and an id already present;
  - renderer: the share dialog (new and existing targets, three default roles), the open dialog hiding
    empty workspaces, and the badge and panel states.
- **e2e (fake server, all three OSes, no git required for this spec):**
  - sign in and share a workspace to a team;
  - a second profile (`SyncProfiles`) opens it as a viewer, edits, sees *Viewer* and cannot push;
  - the fake server's `setRole` promotes the profile to editor; after a fetch the badge changes and the
    push succeeds;
  - a conflict through the fake's history opens the resolver, with both resolutions;
  - an empty server workspace is hidden from the open dialog until an editor shares into it;
  - `revoke(token)` mid-session shows *Sign in*, and polling stops.
- **Manual (owner):** the whole loop against the container image and a real IdP, before the release that
  ships it. The result is recorded in the PR.

## 12. Boundaries

Extends the earlier modules' §12.

- **Always:**
  - keep `SyncService` and the renderer transport-agnostic, beyond §3.5's named changes;
  - validate paths and commit ids on both ends;
  - write client state atomically;
  - keep the contract suite green for git, the fake and the server;
  - refuse a viewer's push on the client and on the server;
  - keep `ServerBackend` free of `electron`.
- **Ask first:**
  - chunked snapshots;
  - a server-side merge;
  - branches;
  - live updates;
  - sharing history;
  - any change to the conflict semantics the contract fixes;
  - moving a workspace between kinds;
  - widening the desktop's git allow-list.
- **Never:**
  - run git on the client for a server workspace;
  - publish local commits during a pull;
  - trust a client-supplied author;
  - write a machine-local file into a snapshot or commit;
  - delete a repository, including from *Stop sharing*;
  - block editing for a viewer;
  - let a commit id reach git unvalidated.

## 13. Success criteria (done when all are true)

1. The backend contract suite passes for `GitBackend` and `FakeServerBackend` in the desktop, and for
   `ServerBackend` against a real server in `server-integration`.
2. A workspace shared to a team from one profile opens in another profile without git installed, and
   both profiles see each other's pushes after a fetch.
3. A viewer edits and sends, but sees *Viewer* and cannot push, on the client and on the server (`403`).
   Promotion to editor takes effect on the next fetch, and the pending commits push.
4. A rejected push pulls, merges and retries. A conflict goes through the existing resolver both ways,
   and the result pushes.
5. An empty server workspace is hidden from *Open a team workspace…*. Sharing into it adopts its id, and
   it then opens for teammates. Sharing a workspace again after *Stop sharing* reconnects through a
   merge.
6. Sign-out, a disabled account and removed access show the specified states and stop polling. Signing
   back in resumes.
7. Repository hooks are proven not to run. `close()` drains the repository store, and a delete racing a
   push answers `404`.
8. `docs/collaborate.md` and the docs site describe sharing to and opening from Wirebench Server,
   including the viewer behaviour, empty workspaces, reconnecting and the "one instance" deployment
   note. ADR-0012 is written and the amended documents say so.
9. `WIREBENCH_SKIP_PERF=1 pnpm check` is green, and the e2e spec passes on all three OSes.
10. Issue #74's first-slice boxes are ticked, with presence, SAML, SCIM and audit moved to follow-up
    issues.

## 14. Migration and compatibility

- `workspaceShareSchema`'s `server` block gains optional fields with defaults, and stricter checks
  (a ULID id, no `path`). No shipped workspace has a server share, so no version bump is needed.
- `create-backend.ts` stops returning the placeholder for `server` shares.
- `WORKSPACE_FORMAT_VERSION` is unchanged: the tree format is the git tree format.
- `GitCli`'s new `run()` options are optional, so existing callers are unchanged.
- `mergeFiles`'s new argument defaults to today's behaviour.
- A server without the `sync` capability gets a clear refusal (§3.4), not a `404`.

## 15. Risks

- **Merge parity with git.** The contract suite is the guard; any divergence surfaces there first.
- **Large workspaces.** Attachments could exceed `bodyLimitMb`. The mitigation: `sync-too-large` names the
  limit, the operator can raise it, and chunking is a listed follow-up.
- **Polling cost.** A sixty-second fetch per open workspace is one small GET, which is acceptable for a
  team. Stop-polling ends the loops for signed-out and removed users.
- **Two writers on the tree.** A user may edit files while a merge writes them. The same self-write TTL
  and held-watcher rules the git backend relies on apply unchanged.
- **Adoption.** Renaming a workspace directory could leave a stale id in the workspace state if it were
  interrupted. The rename is one `rename(2)`, the state update comes after it, and the launch sweep treats
  an unknown id like any missing workspace.
- **Cross-package test import.** The server's contract run imports desktop source. The `electron`-free rule
  and the listed `include` entries in `tsconfig.test.json` keep that working. A desktop change that adds
  `electron` to the backend's imports fails the server job loudly.

## 16. Decisions (formerly open questions)

1. Snapshot format: **JSON, with base64 for binary.** A tar stream is a follow-up if size becomes a
   problem.
2. Fetch interval default for server shares: **60 s**, as for git.
3. Viewer commit-on-save: **on**, so the local log and unsaved recovery work; the push is disabled.
4. Server `capabilities` name: **`sync`**.
5. Empty server workspaces: **hidden until shared, and share can target them (O1).**
6. Sharing again after *Stop sharing*: **reconnect through a merge (O2).**
7. Share dialog default roles: **No access, Viewer, Editor; default Viewer (O3).**
8. Where the real-server contract runs: **the server package (O4).**
