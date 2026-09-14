# ADR-0007: Shared workspaces are git repositories, synced by system git

- Status: accepted
- Date: 2026-09-13
- Context: `docs/specs/2026-09-13-wirebench-shared-workspaces-design.md`; builds on ADR-0003
  (project folder format), ADR-0004 (secrets outside project files), ADR-0005 (renderer path
  safety), ADR-0006 (workspaces in app data), which this ADR partially supersedes (see that ADR's
  update note)

## Context

A workspace (ADR-0006) groups projects and owns environments, but it lives in one user's app-data
folder with no way to propagate to a teammate. A team that wants to share requests and
environments today has one bridge: linking a project folder that happens to live in git, one
project at a time, leaving environments and any internal project behind.

The roadmap ("Teams and sign-in") always intended two routes to team use: git-native teams for
small developer teams with existing git hosting, and a self-hosted Wirebench Server for
enterprise sign-in, roles and an audit trail. Building the server first would mean designing a
merge and conflict model twice — once for the server's own storage, once if a git-native path
were added later — or committing to only one path forever.

## Decision

**A shared workspace is a git repository, whether the user's own machine runs `git` or
Wirebench Server does.** Concretely:

- **Files are the protocol.** The shared tree — `workspace.yaml`, `environments/`, the internal
  projects' folders, `.gitattributes` — is exactly the format `ADR-0003` and the workspaces spec
  already define, minus the per-machine fields (`activeEnvironmentId`, `writtenBy`) this spec
  moves out. Nothing new is invented to represent "what is shared": it is the same YAML and XML a
  local workspace already writes.
- **System git, never bundled.** Wirebench finds the git already installed on the machine
  (`findGit`, minimum 2.20) and runs it with `execFile`, argument arrays, a hardened environment
  (no shell, no prompts, hooks disabled) and a small allow-listed set of subcommands. A workspace
  with git absent still works as a plain folder; nothing in the app ships or requires its own git
  implementation. This keeps the "no new runtime dependency" boundary the whole app holds to, and
  it means every git hosting product (GitHub, GitLab, Azure DevOps, Gitea, a bare repository on a
  network share) already works with no integration of its own — permissions, SSO and audit trails
  are the host's, not Wirebench's, to build.
- **One `SyncBackend` interface, several transports.** `probe`, `fetch`, `merge`, `commit`,
  `push`, `conflicts`, `resolve`, `finishMerge`, `abortMerge`, `log`, `changedPaths`, `identity`,
  `subscribeRemote` are implemented today by `GitBackend` (over system git) and `FolderBackend`
  (a synced folder with no sync control of its own, rejecting most calls with
  `sync-not-supported`). Wirebench Server (a later spec) implements the same interface as
  `ServerBackend`: `fetch`/`merge`/`push` become one round trip that posts changed files and
  receives either the new head or a conflict list for the *same* resolver UI, and
  `subscribeRemote` becomes a WebSocket instead of a no-op. The engine's merge, the conflict
  model, the UI, and the contract test suite are written once, against the interface, and are
  reused as-is by the server.
- **The whole workspace is the shared unit**, not one project at a time. Environments — the one
  thing that never left a machine before this — travel with the workspace because they are just
  more files in the same tree.
- **Secrets stay per member.** Refs (`sec_…`) are ordinary tree content and are identical on every
  machine; values stay in each member's OS keychain (ADR-0004), unaffected by this ADR. Shared,
  encrypted secret values are an explicit non-goal here and a listed follow-up for the server.

## Consequences

- **A shared workspace's history *is* the team's audit trail**, for free, in whatever git hosting
  the team already uses — no separate history feature to build or secure.
- **The merge granularity is a file, and one file is one entity** (one request, one environment,
  one project's settings) by construction of the existing project format. This keeps most
  concurrent edits from ever conflicting, at the cost of line-level conflicts inside one entity
  that two people edited at once — mitigated by the in-app resolver, not by a smarter merge
  algorithm (see Alternatives, "a YAML-aware merge driver").
- **The server (spec 2) inherits a working sync engine for free.** Its own spec need only add
  transport (HTTP + WebSocket instead of local git), sign-in and presence; the tree format, the
  conflict resolver, the banners and the contract tests do not change.
- **A plain synced folder is supported but only as a fallback.** Anything beyond one person
  working across their own machines wants git's actual merge behaviour; the guide says so
  plainly rather than pretending the two are equivalent.
- **Windows and CRLF edge cases become the app's problem to mitigate**, not eliminate:
  `.gitattributes` and `-c core.autocrlf=false` handle line endings; `core.longpaths` is a guide
  note, not something the app can set globally on the user's behalf.
- **Repository hooks and local config are real capabilities of a repository the app must
  neutralise**: every git invocation the app makes uses `core.hooksPath=<empty directory>`, so
  hostile *remote content* — hooks, or anything else a fetch, merge or clone brings in — cannot
  execute code when joining, pulling or committing. A repository's *local config*
  (`.git/config`) never travels with a clone, but a folder the user points the app at can carry
  one; every key in it must be on an allow-list (what `init`/`clone` and the app itself write, plus a
  few line-ending and fetch/pull settings), and every `remote.*.url` value must pass the remote URL
  allow-list, before the app runs anything else in that repository and at every open. An
  allow-list, not a list of refused keys: git has too many settings that run a program (worktree
  config, alternate-refs commands, signing key commands, URL rewrites) for a deny-list to hold.

## Alternatives considered

- **A custom operation journal.** Record each user action as an append-only log entry and replay
  it on every machine, instead of relying on git's own commit/merge model. Rejected: it
  duplicates what git already does well (ordering, merge, conflict detection, transport,
  permissions via hosting), for a novel format nobody outside Wirebench could inspect, diff or
  host on infrastructure they already trust. It would also need to be reinvented, not reused, for
  the server.
- **A CRDT over the workspace tree.** Would remove conflicts entirely for the operations it
  covers, at the cost of a much larger implementation (state or operation-based CRDT plumbing for
  every entity type, or a generic document CRDT that does not understand SOAP requests as
  entities) and files that are no longer plain YAML/XML a user can read, diff or edit by hand
  outside the app. Rejected for this version; not ruled out forever if real-time co-editing
  becomes a goal rather than the explicitly non-goal it is here.
- **A separate server-only model, git-native teams shelved.** Build Wirebench Server's own
  storage and sync protocol first, and treat "teams with existing git hosting" as a smaller,
  later feature layered on top if there is demand. Rejected: it ships the smaller team's need
  later than necessary, and it risks designing a merge and conflict model twice instead of once
  behind `SyncBackend`. The chosen order — git first, `SyncBackend` shaped so a server slots in
  without touching the tree format — lets the harder, higher-value feature (the server) start
  from a sync engine already proven by real usage rather than from a blank page.
