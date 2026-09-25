# ADR-0012: Server sync merges on the client; the server stores commits

- Status: accepted
- Date: 2026-09-25
- Context: issue #74; `docs/specs/2026-09-24-wirebench-server-sync-design.md`. Amends
  [ADR-0008](0008-shared-workspaces-are-git-repositories.md)'s server bullet. Builds on
  [ADR-0009](0009-wirebench-server-is-a-fastify-postgres-process.md) (the server process) and
  [ADR-0011](0011-workspace-roles-are-team-default-plus-grants.md) (who may push).

## Context

ADR-0008 anticipated a `ServerBackend` whose `fetch`, `merge` and `push` would be one round trip: the
client posts its changed files and the server answers with either a new head or a conflict list, which
means the server runs the three-way merge.

Two things settled against that. First, the backend contract suite
(`apps/desktop/test/sync/backend-contract.test.ts`) fixes `merge()` as an operation that leaves the client
*ahead* until `push()`: a pull must never publish local commits. A merge on the server either publishes
them as it merges, which breaks that contract, or needs a dry-run endpoint that returns what a client
computes from a diff anyway. Second, the engine's `mergeFiles` is the same code wherever it runs, so
running it on the server buys nothing and costs a merge worktree per workspace on the server.

## Decision

- **The three-way merge runs on the client**, in `ServerBackend`, with the engine's `mergeFiles` and the
  same conflict model and resolver as a git share. The client keeps its base and its pending commits in
  `<workspace>/server/`.
- **The server stores commits and nothing else.** Five routes under
  `/api/v1/workspaces/:workspaceId/sync`: `head`, `snapshot`, `changes`, `commits` and `log`. A push
  names its parent. If the parent is not the head, it answers `409 sync-push-rejected`. The client then
  pulls, merges and retries, exactly as it does after git refuses a non-fast-forward push.
- **Git stays the storage format on the server.** Each workspace is a bare repository written with
  plumbing through a private index file, one push at a time inside `RepoStore.withLock`, with hooks
  disabled. The server never checks out a tree and never merges.
- **Roles are enforced on both sides.** The server refuses a viewer's push with `403`. The client
  disables Push and Push on save for a viewer and never sends one.

## Consequences

- The merge, the conflict model, the resolver UI and the contract suite are shared by every backend, and
  the same contract runs against a real server in `server-integration`.
- The server needs no worktrees, no merge endpoint and no merge code. `tmp/` holds only private index
  files, which are swept at start-up.
- A client needs no git: the desktop talks HTTP, and a workspace opened from a server works on a machine
  without git.
- A push can be rejected repeatedly while others push. That is the same trade-off a git remote makes, and
  the client retries once per push, as it does for git.
- Pushes are serialised by an in-process lock, so one server instance serves one data directory. Running
  several instances needs a shared lock first.

## Alternatives considered

- **A server-side merge in a worktree**, as ADR-0008 sketched. Rejected: it publishes local commits on
  pull, or needs the dry-run endpoint below, and it puts a checkout per workspace on the server.
- **A dry-run merge endpoint** that returns the merged files and conflicts without committing. Rejected:
  it returns the same data the client computes from `changes` and its own base, over a larger response.
- **Git on the client over smart HTTP**, with the server as a git remote. Rejected: the desktop would need
  git installed, and roles would have to be enforced in git's protocol rather than in one route guard.
- **Snapshots only, with no history.** Rejected: the Sync panel's *Recent commits*, the `behind` count
  and the ancestor check all need commits, and git already stores them compactly.
