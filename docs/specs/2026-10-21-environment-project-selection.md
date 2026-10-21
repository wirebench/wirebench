# Environment project selection — design

**Date:** 2026-10-21
**Status:** Approved 2026-10-21
**Scope:** Issue #393. Builds on the project-scoped environments design
(`docs/specs/2026-10-12-project-scoped-environments-design.md`, #468) and the environment details panel (#581).

## Goal

A workspace environment applies to every project by default and can be narrowed to chosen projects. The choice is
made in its own panel on the right of the environment's page: the workspace's projects, each with a checkbox, and
**All projects** at the top.

## Already there (#468, shipped in 6.1.0)

Most of #393 landed with #468 and does not change here:

- `projects` in `environments/<slug>.yaml`, a list of project ids; absent = every project (including ones added
  later), `[]` = none. Unknown ids are kept. No workspace format bump (owner ruling, 2026-10-12).
- Each project keeps its own active environment (`local.yaml` v3). An environment that does not apply to a project
  is never active for it: main drops the entry when a scope narrows, and the renderer's `activeEnvironmentFor`
  ignores a stale one. Such a project resolves through Workspace and Globals only.
- The title-bar switcher lists only the environments that apply to the focused request's project.
- CLI `--env` and the MCP server's `environment` argument go through `pickEnvironment`, which fails
  `environment-out-of-scope` (exit 2) with the names in scope.
- A linked project's own environment of the same slug is unaffected by the scope.
- Removing a project drops its id from every scope (`withoutProject`); an emptied scope stays `[]` and shows as
  **No project**.
- Engine unit tests for the file format (`roundtrip.test.ts`) and resolution (`environments.test.ts`).

## Owner rulings (2026-10-21)

1. A project the active environment excludes resolves with **no environment**: it does not fall back to its own
   linked environment. Already how #468 behaves.
2. The switcher **hides** environments that do not include the focused project. Already how #468 behaves; the
   environment active for that project can never be one of them, so nothing stays visible by exception.

## What changes

### A Projects panel of its own

The **Applies to** radio group leaves the Environment details panel. An environment tab in front offers two icons on
the right rail: **Environment details** (as today) and **Projects**. Each opens the right slide-over; opening one puts
the other away, since there is one slide-over. Escape and the header's close icon put the open one away.

The Projects panel (`features/environments/environment-projects.tsx`) holds only the selection:

```
Which projects this environment applies to
[x] All projects            ← includes projects added later
───────────────────────
[x] Alpha API
[x] Beta API
[ ] CRM
Ticked projects only; a project added later is not included until it is ticked.
```

- **All projects** ticked: `projects` is absent. Every project row shows ticked. Clearing a project row narrows the
  environment to every other project (the scope becomes the list of the workspace's project ids minus that one), so
  nothing drops out of a switcher until a box is cleared.
- **All projects** cleared: the scope becomes every project of the workspace, each row ticked and editable.
- Ticking every row by hand does not turn **All projects** back on: a narrowed environment stays narrowed, which is
  what keeps a project added later out of it. Ticking **All projects** sets `projects` to absent again.
- Clearing every row is allowed. The panel then reads **Applies to no project**, and the view's chip reads
  **No project**, as today.
- Each edit is queued and built from the environment as it stands (`queueEnvironmentPatch`), so an id this machine
  does not know is kept.
- A linked project's own environment belongs to its project: the panel reads **<Project> only** and offers nothing.

The details panel's **Applies to** row becomes a summary (**All projects**, the project names, or **No project**) with
a **Choose projects…** button that opens the Projects panel.

### Persisted panel state

`slideOver.environmentProjectsOpen` joins `environmentDetailsOpen` in the UI state (absent = hidden). Opening the
Projects panel sets it and clears `environmentDetailsOpen`; opening the details panel does the reverse. Closing a panel
clears its own flag only. `rightPanelFor` does not change: the area's panel kind stays `environment-details`, and the
rail shows both icons for it.

### Published JSON Schema

The workspace environment file has had no published schema; the published `environment.schema.json` describes a
*project's* environment file, which never carries `projects`. The engine gains `WORKSPACE_FILE_KINDS` and
`workspaceJsonSchemas()`, published by the same script under `docs-site/public/schemas/workspace/v<workspace format>/`:
`environment.schema.json` for `environments/*.yaml` with `projects` as an optional list of non-empty strings. The
loader stays lenient about a malformed `projects` (it reads as absent); the schema is stricter on purpose, so an editor
flags what the loader would silently ignore. The workspace schemas are not added to the editor's `yaml.schemas`
mapping, whose globs would clash with the project ones; the project-format reference names them instead.

### Status bar and request editor

The issue asked both to say when the active environment does not apply to the project. With per-project active
environments that state cannot occur: a narrowed environment is simply no longer the project's choice, and the
switcher reads **<Project> · No environment** for it. No new notice is added.

## Tests

- **Engine unit:** a saved workspace with a narrowed environment validates against the published workspace
  environment schema, and a malformed `projects` fails it.
- **Renderer unit:** the Projects panel's patches for each click (clear a row under All projects, tick All projects,
  clear the last row); the rail shows both icons for an environment tab and one panel puts the other away.
- **E2E:** `environment-details.spec.ts` and `environments-scope.spec.ts` move to the Projects panel; the details
  spec covers opening it from the rail and from **Choose projects…**, narrowing, the chip, and the selection after a
  relaunch.

## Out of scope

- A per-request or status-bar notice (see above).
- Scoping imported environments to their project (open question from #468).
