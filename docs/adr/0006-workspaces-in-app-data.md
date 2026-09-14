# ADR-0006: Workspaces live in app data, not as a folder the user manages

- Status: accepted; superseded in part by [ADR-0007](0007-shared-workspaces-are-git-repositories.md)
- Date: 2026-09-12
- Context: `docs/specs/2026-09-11-wirebench-workspaces-design.md` (spec §1, §14, §16)

**Superseded in part by ADR-0007 (2026-09-13).** A shared workspace's tree may now live outside
the app-data directory: `share.yaml` (never itself inside the tree) can name an external folder —
picked only through a native dialog, and refused if it lies inside `<userData>` — for a git clone
or synced folder the user manages themselves. A *local* workspace is unaffected: its tree still
lives entirely under `workspaces/<id>/` exactly as this ADR describes, and `share.yaml`'s absence
is what "local" means.

## Context

Through v1, "open a project" meant a native folder dialog: the user picked a directory, and
that directory was the entire unit Wirebench knew about. That is fine for one project. It falls
apart as soon as someone wants several projects open together — a service and the two others it
calls, say — with one set of environments and one history view across them. Asking the user to
first create and organize a parent folder themselves, before Wirebench does anything, is exactly
the kind of housekeeping the tool should be doing.

## Decision

Wirebench no longer asks the user to manage folders in the normal flow. A **workspace** is a
directory under Electron's `userData`, at `workspaces/<id>/`, holding:

```
workspaces/<id>/
  workspace.yaml            # formatVersion: 1, name, properties, activeEnvironmentId, project refs
  environments/<slug>.yaml  # one file per workspace environment: properties + endpoint overrides
  projects/<slug>/          # internal projects — ordinary ADR-0003 project folders, unchanged
```

- **Projects keep their format.** A project inside a workspace is byte-for-byte the same
  `formatVersion: 1` folder ADR-0003 describes; the workspace only adds files around it. This is
  what makes `export` a plain copy and `import` a plain copy-and-reidentify.
- **External folders are linked or imported, never opened directly.** *Link existing project
  folder…* records an external, absolute path in `workspace.yaml` and reads/writes the project
  in place — the git bridge for a team that keeps a service's project under version control.
  *Import project folder…* copies a folder in and re-identifies its entity ids, so the same
  folder can be imported into two workspaces without an id collision. *Export project…* is the
  reverse: it writes the project's current in-memory model to a folder the user picks.
- **Environments live at the workspace, one active at a time.** New environments are workspace
  environments, referenced by every project in the workspace via a `${#Workspace#…}` property
  scope inserted between project and global (`Env → Project → Workspace → Global`). A project's
  own environment only still matters for a **linked** project, matched to the active workspace
  environment by name, and wins over the workspace's value when both define the same key — the
  linked project's own file is the thing under the team's git history, so it gets the last word.
  Internal projects created inside a workspace have no environments of their own at all.
- **Deletion is trash-only.** Removing an internal project moves its folder to the OS trash
  (`shell.trashItem`) after a confirmation dialog; a linked project's folder is never touched,
  only the workspace's reference to it. There is no `rm -rf` anywhere under `userData` or a
  linked root.
- **The picker is the front door.** Launch shows the workspace it last had open, or a picker
  listing every workspace on failure or on first run — never a folder dialog.

## Rationale

- **Grouping is the actual feature.** Several projects, one set of environments, one history
  view and shared tabs are what a workspace buys; a bag of independent folders cannot offer
  that without the app owning where they live.
- **App data over a user-chosen root** removes an early decision ("where do I put this?") that
  has no good default answer and matters to nobody once the workspace exists — the same reason
  browsers keep profiles in app data rather than asking where to put them.
- **Keeping the project format unchanged** means nothing built for ADR-0003 — the loader, the
  path-safety rules of ADR-0005, `export`, git — has to know a workspace exists. A project is a
  project; only the thing pointing at it differs by one bit (`internal` vs `linked`).
- **Link and import, not "open", for external folders** keeps git as the one supported bridge
  in and out, without letting an arbitrary filesystem path become a live part of the workspace
  model by default — that stays an explicit, secondary action.

## Consequences

- **Export and link are the only ways in or out of git.** A team that wants a project under
  version control links it (edits in place, tracked by their own repo) or exports periodically
  (a manual, one-shot copy). There is no third option, and no automatic sync between an internal
  project and a git remote.
- **The workspace manifest has its own `formatVersion`**, independent of the project format's.
  `workspace.yaml` and `environments/*.yaml` are versioned, migrated and validated the same way
  ADR-0003 requires for a project: an additive field is a format bump, not a free change, and a
  newer format than the app understands fails with a clear error rather than a guess.
- **The dialog-pick set is session-wide, not scoped to a single workspace or project.** Link,
  import and export all resolve through the same `DialogPicks` instance the whole session
  shares (ADR-0005's mechanism for trusting a renderer-named path). This is an accepted
  trade-off: it is simpler than threading a workspace- or project-scoped pick set through every
  channel, and the actual security property — a path only counts if the user drove a native
  dialog to it *this session* — is unaffected either way.
- **A user managing many workspaces manages them through the app**, not through a file manager;
  there is no folder to rename or move around outside Wirebench's own *Manage Workspaces* UI.
- **Multi-window and workspace sync/sharing stay out of scope** (recorded on the roadmap): one
  window holds one open workspace at a time, and nothing propagates a workspace's environments
  or projects to another machine.

**Update (2026-09-12, per-variable enabled flag): `formatVersion: 2`.** `workspace.yaml` and each
workspace environment file gained the same `disabled:` sibling list ADR-0003 describes for the
project format, for the same reason and with the same shape — a variable switched off without
being deleted, sorted and deduplicated, omitted when empty, absent-means-all-enabled on
migration. `WORKSPACE_FORMAT_VERSION` moved to `2`; a version-1 workspace still opens, and a
version-3-or-later one is refused with the existing "created by a newer version of Wirebench"
error, the same as a project. The global properties file (`apps/desktop/src/main/
global-properties.ts`, outside the engine's own format versioning) gained the identical list and
moved to `version: 2`, but its loader does not yet validate that field on read — see the roadmap's
"Known limitations carried from 1.0".
