# Project-scoped environments — design

**Date:** 2026-10-12
**Status:** Draft — for owner review
**Scope:** Issue #468. Builds on the workspaces design (`docs/specs/2026-09-11-wirebench-workspaces-design.md`), the
Environments view (`docs/specs/2026-09-12-wirebench-layout-and-environments-design.md`) and the environment guard
(`docs/specs/2026-10-11-environment-colour-and-guard-design.md`).

## Goal

A workspace environment either applies to every project (as today) or to a chosen set of projects. The switcher only
offers environments that apply to the project of the open request, and each project remembers its own active
environment.

## Owner decisions (2026-10-12)

1. Environments stay workspace files, `environments/<slug>.yaml`. Scope is a field in that file.
2. The active environment is **per project**. Moving from a project A tab to a project B tab shows B's last pick, or
   *No environment* if B has none.
3. A scoped environment can apply to **one or more** projects.
4. Linked (git) projects **keep** their own environments in the project folder, name-linked by slug as today.

## Today (what changes)

- `packages/engine/src/workspace/schema.ts:61-77`: the environment file holds `id, name, order, properties, endpoints`,
  with optional `disabled, color, protected`. The schema is loose, and environment files carry no version.
- `packages/engine/src/workspace/local-state.ts:35-48`: one `activeEnvironmentId` per workspace in the machine-local
  `local.yaml` (strict, version 1|2). `Workspace.activeEnvironmentId` holds it in memory (`model.ts:91-95`).
- `apps/desktop/src/main/workspace-service.ts:2802-2831`: `setActiveEnvironment(environmentId | null)`, behind IPC
  `workspace.setActiveEnvironment` (`shared/ipc.ts:665`).
- `features/environments/env-switcher.tsx:76-120` lists every workspace environment. The environment page header has an
  *Active* toggle.
- Everything that needs the active environment reads the single workspace-wide id: `project-host.ts` (`runContextFor`
  at 345-376, `sendEnvironments` at 389-410) and the resolvers in `packages/engine/src/workspace/environments.ts`.
- The CLI and MCP never read the active environment. `--env` / `environment` is always explicit
  (`packages/cli/src/ops/environment.ts`).

## Design

### File format

```yaml
# environments/billing-sandbox.yaml
id: 01J…
name: Billing sandbox
order: 3
projects: [01HB…, 01HC…]   # project ids; absent = all projects
properties: { … }
endpoints: { billing/payments: https://sandbox.billing.example }
```

- `projects` lists **project ids** (the ULIDs in `workspace.yaml`), not slugs, so a slug change that arrives from disk
  or a pull does not break the scope.
- Absent `projects` means *all projects*. `projects: []` means *no project* (see Removing a project).
- Ids that name no project in the workspace are ignored on read and kept on write, because a teammate may have a
  project this machine has not pulled yet.
- **Older builds.** The workspace schema is loose, so an older build reads a scoped environment as an all-projects one
  (it shows more, it never hides data). But its serializer writes only the fields it knows, so if a teammate on an
  older build *edits* that environment, `projects` is dropped and the environment becomes all-projects again.
  `color`/`protected` (#345) took the same trade without a bump. Whether to bump `WORKSPACE_FORMAT_VERSION` (4 → 5) and
  have older builds refuse the workspace is open question 2.

### Active environment per project

- `local.yaml` goes to version 3: `activeEnvironments: { <projectId>: <environmentId> }` replaces
  `activeEnvironmentId`.
- Migration from v1/v2: the old `activeEnvironmentId` is copied to every project in the workspace. No environment is
  scoped yet, so it applies to all of them. A legacy id in a v1/v2 `workspace.yaml` takes the same path.
- A project with no entry has no active environment. A new or newly linked project starts with none.
- An older build that meets a v3 `local.yaml` ends up with no active environment (`loadLocalState` never throws). That
  is acceptable: the file is machine-local and costs one pick.
- In memory, `Workspace.activeEnvironmentId` becomes `activeEnvironmentIds: ReadonlyMap<projectId, environmentId>`.
- An entry is dropped when its environment is removed, or when a scope change leaves its project out.

### Which project is current

The current project is the project of the focused request tab. When the focused tab has no project (Settings, SSH, an
environment page), the switcher keeps showing the last project's state and stays usable for it. Its label names that
project.

### Switcher

```
Billing ▾  (project the switch applies to)
  All projects
    ● Dev
      Staging
  Billing
      Billing sandbox
  ─────────────
  No environment
  Manage environments…
```

- Two groups: *All projects*, then the current project's scoped environments, each sorted by `order`. A group with no
  entries is not shown.
- `env.next` cycles through the same list.
- Picking calls `workspace.setActiveEnvironment { projectId, environmentId | null }`. The request gains `projectId`,
  which the renderer always knows from the focused tab.

### Environments view and editor

- The environment page header gains **Applies to: All projects | Selected projects**, with a project multi-select.
- The *Active* toggle applies to the current project. It is disabled, with a tooltip, when the environment is out of
  scope for that project.
- The endpoints table lists only the interfaces of projects in scope. Overrides for a project that leaves the scope stay
  in the file but are not shown or used, and adding the project back brings them back.
- The sidebar list shows small project chips on scoped environments. An environment scoped to no project shows *No
  project*.
- Duplicating an environment keeps its scope.

### Resolution and sends

- `resolveWorkspaceScopes`, `resolveWorkspaceEndpoint` and `resolveWorkspaceApiBaseUrl` take the environment from
  `activeEnvironmentIds.get(projectId)` instead of the workspace-wide id. `withActiveEnvironment(workspace, envId)`
  keeps its signature for the paths that name an environment explicitly.
- Name-linking (`linkedEnvironment`) and precedence do not change.
- A send, run or sequence whose environment is out of scope for its project is refused with `environment-out-of-scope`.
  The UI never offers that case; the check guards the explicit paths below and stale state.
- `runContextFor` uses the target project's active environment, captured at run start as today. The data runner and the
  sequence runner change only through `runContextFor`. The protected guard (#345) does not change.
- **Send to environments…** (`sendEnvironments`, `useMultiEnvState`) offers only the environments in scope for the
  request's project.

### CLI and MCP

- `pickEnvironment` matches only environments in scope for the project. A name that exists but is out of scope fails
  with `environment-out-of-scope` (exit 2) and lists the in-scope names.
- `environment-required` fires only when the project has at least one environment in scope.
- MCP: the `environment` argument goes through the same pick, and the `--env a,b` gate does not change. Tool
  descriptions that list environments list only those in scope for the project.

### Removing a project

- Removing a project drops its id from every environment's `projects` and deletes its `<projectSlug>/…` endpoint keys.
  Today those keys are left behind as orphans (`removeProjectNow`, `workspace-service.ts:2156-2186`).
- An environment whose scope becomes empty is kept with `projects: []` and shows as *No project* in the view, so
  nothing the user typed is lost. The remove dialog names those environments.
- Moving a project to another workspace does not carry its scope, because the target workspace has its own
  environments.

### Imports

`ensureEnvironments` creates workspace environments when a linked project brings its own (`workspace-service.ts:2662`).
It now creates them scoped to that project. An existing workspace environment with the same slug is reused, and if that
environment is scoped, the project is added to its scope.

### Sync, secrets, audit

- The server and sync treat `environments/*.yaml` as plain workspace files, so the server does not change. The commit
  message for a scope change is "Scope environment QA to Billing, CRM" or "Apply environment QA to all projects"
  (`packages/engine/src/workspace/commit-message.ts`).
- Team secrets and secret sources are workspace-wide and do not change.
- Run history and audit events keep recording the environment name.

## Slices

| # | Slice | Main files |
|---|---|---|
| S1 | Engine: `projects` in schema/model/serialize, `local.yaml` v3 and its migration, per-project resolvers, `environment-out-of-scope` | `packages/engine/src/workspace/*` |
| S2 | Desktop main: per-project active map, `setActiveEnvironment { projectId }`, scope in `mutate`, `runContextFor`, `sendEnvironments`, project-removal cleanup, imports | `workspace-service.ts`, `project-host.ts`, `multi-env-send.ts`, `wire-base.ts`, `ipc.ts` |
| S3 | Renderer: grouped switcher, *Applies to* editor, scoped endpoints table, chips, multi-env picker | `features/environments/*`, `features/multi-env/*`, `state/workspace.ts` |
| S4 | CLI and MCP scope checks | `packages/cli/src/ops/environment.ts`, `ops/project.ts` |
| S5 | Docs guide and e2e | `guides/environments.mdx`, `e2e/specs/` |

## Testing

- **Engine unit:** schema round-trip with and without `projects`; unknown ids kept; `local.yaml` v2 → v3 migration;
  resolution per project; out-of-scope refusal.
- **Desktop main:** the active environment per project survives a reload; removing an environment or narrowing a scope
  clears the matching entries; removing a project cleans scopes and endpoint keys.
- **Renderer:** switcher groups for a project with and without scoped environments; `env.next` order; the *Active*
  toggle is disabled when out of scope.
- **CLI:** an out-of-scope `--env` exits 2 with the in-scope list; `environment-required` ignores out-of-scope
  environments.
- **E2E:**
  1. Scope `Billing sandbox` to project A; a project B request does not offer it.
  2. Pick it on A, then switch to a B tab: the switcher shows B's pick.
  3. Switch back: it shows `Billing sandbox`.

## Found in passing (separate issues)

- Renaming a **project** environment re-derives its slug, which silently breaks its name-link to the workspace
  environment (`project-environment-mutations.ts:51-65`).
- `wirebench run --sequence` inside a workspace looks up the environment name only in `project.environments`
  (`packages/cli/src/commands/sequence.ts:210`), so the name is likely missing from the result.
- Interface and API renames re-derive slugs but do not rewrite the `<projectSlug>/<interfaceSlug>` endpoint keys.

## Open questions

1. When a removed project leaves an environment with an empty scope: keep it as *No project* (proposed), delete the
   environment, or turn it back into all-projects?
2. Should the workspace format be bumped so older builds refuse a workspace with scoped environments, rather than drop
   `projects` on edit (no bump proposed, as with #345)?
3. Milestone: 6.0 or Later?
