# Plan: project-scoped environments

Spec: [2026-10-12-project-scoped-environments-design.md](../specs/2026-10-12-project-scoped-environments-design.md) ·
issue #468 · milestone 6.0. One commit per task. Each commit goes in only after
`NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## Global constraints

- `projects:` holds project **ids**, never slugs. Absent = all projects. `[]` = no project.
- No `WORKSPACE_FORMAT_VERSION` bump. `local.yaml` goes to version 3.
- Ids that name no project in the workspace are kept on write.
- Error code for every out-of-scope use: `environment-out-of-scope`.
- The resolvers in `packages/engine/src/workspace/environments.ts` keep their signatures. Per-project resolution is
  done by handing them a workspace whose `activeEnvironmentId` is the project's (see Task 1).
- Name-linking, precedence and the protected guard do not change.
- No competitor names anywhere (`pnpm check:banned-terms`).

## Review focus

Each of these gets a test in the task named.

1. A pull deletes the environment a project has active: the entry is dropped and the switcher shows *No
   environment*; no error (Task 2).
2. A pull narrows a scope so the project's active environment is out of scope: the entry is dropped on reload
   (Task 2).
3. Editing a scoped environment whose `projects` has an id this machine does not know keeps that id (Task 1,
   Task 2).
4. A project's slug changes on disk: its scope and active entry survive because both key on the id (Task 2).
5. The focused tab has no project and no project was focused before (fresh launch on Settings): the switcher
   shows no project and is disabled, with no error (Task 5).

## Task 1: engine — scope field, per-project active state, `local.yaml` v3

Files: `packages/engine/src/workspace/{schema,model,load,serialize,local-state,environments,commit-message}.ts`.

- Schema: `projects: z.array(z.string().min(1)).optional()` on `workspaceEnvironmentFileSchema`.
- Model: `WorkspaceEnvironment.projects?: readonly string[]`. Load maps it through. Serialize writes it only when
  present, so `[]` is written and absent is not.
- `Workspace` gains `activeEnvironments: Readonly<Record<string, string>>` (project id → environment id), the
  per-project state. `activeEnvironmentId` stays as the **resolution slot** the resolvers read; update its doc
  comment to say so. Only `workspaceForProject` and `withActiveEnvironment` set it.
- New exports in `environments.ts`:
  - `appliesToProject(environment: WorkspaceEnvironment, projectId: string): boolean`
  - `environmentsForProject(workspace: Workspace, projectId: string): readonly WorkspaceEnvironment[]`, in `order`
  - `activeEnvironmentFor(workspace: Workspace, projectId: string): WorkspaceEnvironment | undefined`. This
    returns undefined when the entry is missing, its environment is gone, or it is out of scope.
  - `workspaceForProject(workspace: Workspace, projectId: string): Workspace`, i.e.
    `withActiveEnvironment(workspace, activeEnvironmentFor(...)?.id)`
  - `assertEnvironmentInScope(workspace, environmentId, projectId): void`, which throws the engine's coded error
    `environment-out-of-scope` with `{ environmentName, projectId }`
- `local-state.ts`:
  - Version 3 adds `activeEnvironments?: Record<string, string>` and drops `activeEnvironmentId`.
  - The schema accepts 1|2|3. A v1/v2 `activeEnvironmentId` is surfaced as `legacyActiveEnvironmentId`, because the
    loader does not know the project list. Task 2 expands it.
  - `EMPTY_LOCAL_STATE` is `{ version: 3 }`.
- `commit-message.ts`: a scope change reads "Scope environment QA to Billing, CRM", or "Apply environment QA to all
  projects" when the scope goes back to all. Project names come from the workspace model; an unknown id shows as the
  id.
- If the workspace JSON Schema is published (`pnpm schemas:project`), regenerate it.
- Tests:
  - Round trip with `projects` absent, `[]` and two ids, plus an unknown id kept.
  - `appliesToProject` for each of the three shapes.
  - `activeEnvironmentFor` with missing, deleted and out-of-scope entries.
  - `resolveWorkspaceEndpoint` through `workspaceForProject` for two projects with different active environments.
  - `assertEnvironmentInScope` throws.
  - `local.yaml` v2 → `legacyActiveEnvironmentId`; v3 round trip; a v4 file → empty state.
  - Commit-message wording.

## Task 2: desktop main — per-project active state, wire, IPC, scope mutations

Files: `apps/desktop/src/main/workspace-service.ts`, `apps/desktop/src/shared/{wire-base,ipc}.ts`,
`apps/desktop/src/main/ipc/workspace.ts`.

- Wire:
  - `WorkspaceWire.activeEnvironmentId` is replaced by `activeEnvironments: Record<string, string>`.
  - `workspaceEnvironmentWireSchema` gains `projects?: string[]`.
  - `workspaceEnvironmentPatchSchema` gains `projects?: string[] | null`, where `null` means all projects and removes
    the field.
- IPC: the `workspace.setActiveEnvironment` request becomes `{ projectId: string; environmentId: string | null }`.
- `setActiveEnvironment({ projectId, environmentId })` throws:
  - `project-not-found` for an unknown project id;
  - `environment-not-found` for an unknown environment;
  - `environment-out-of-scope` when the environment does not apply to the project.
  It then writes `local.yaml` v3 and fires `onChanged`.
- Open (around lines 861-891): a legacy id from `workspace.yaml` or `local.yaml` is copied to every project in the
  workspace whose scope it applies to, then `local.yaml` is resaved as v3.
- Reload (around lines 1305-1313): an entry is carried forward only while `activeEnvironmentFor` still finds it.
  Entries for project ids no longer in the workspace are dropped.
- `mutate`:
  - `update-workspace-environment` applies `projects`, then drops every active entry the new scope excludes.
  - `remove-workspace-environment` drops every entry pointing at the removed environment.
  - Duplicating an environment keeps `projects`.
- Tests:
  - Set/get per project.
  - Out-of-scope refusal.
  - Legacy expansion on open.
  - Survival over reload; a slug change on disk keeps scope and entry (review focus 4).
  - Pull deletes the active environment (review focus 1); pull narrows the scope (review focus 2).
  - A patch from the UI keeps an unknown id (review focus 3).
  - Duplicate keeps the scope.

## Task 3: desktop main — sends, runs, project removal, imports

Files: `apps/desktop/src/main/{project-host,multi-env-send,runner/runner-service,sequence-runner,request-variables}.ts`,
`workspace-service.ts` (`removeProjectNow`, `ensureEnvironments`), `workspace-share.ts`.

- `project-host.ts`:
  - The workspace context handed to the resolvers is `workspaceForProject(workspace, projectId)` (scopes at
    442-462, `resolveEndpointFor` 288-305).
  - `runContextFor` (345-376) uses the project's active environment.
  - `workspaceContextFor(envId)` (328-336) calls `assertEnvironmentInScope` first.
  - `sendEnvironments` (389-410) returns `environmentsForProject`.
  - `certificateSources` (1085-1096) only looks at environments in scope.
- `multi-env-send.ts`: an id that is not in `sendEnvironments` already fails validation, so no new code. Add a test
  for an out-of-scope id.
- Runner and sequence runner: no code change beyond `runContextFor`. Test that a run captures the project's active
  environment at start.
- `removeProjectNow`:
  - Removes the project id from every `projects`. An environment whose list becomes empty keeps `projects: []`.
  - Deletes the `<projectSlug>/` endpoint keys and drops the project's active entry.
  - Returns the names of environments left with `[]` so the dialog (Task 5) can name them. Add that to the reply
    wire type.
- `ensureEnvironments`:
  - A new workspace environment created for a linked project's environment gets `projects: [projectId]`.
  - An existing same-slug environment is reused. If it is scoped, the project id is added.
- Moving a project to another workspace (`copyProjectIntoWorkspace`) does not touch scopes. Add a test asserting
  that.
- Tests: two projects resolve different URLs under different active environments; an out-of-scope explicit send is
  refused; removal cleanup (scopes, keys, `[]`, entry); import scoping.

## Task 4: renderer — state and current project

Files: `apps/desktop/src/renderer/state/{workspace,workspace-tabs,project-endpoint}.ts` and every reader of
`workspace.activeEnvironmentId`. Grep for it: `shell/editor-area.tsx`, `shell/code-panel.tsx`,
`features/{rest-editor,grpc-editor,ws-editor}/*`, `features/{rest-api,grpc-api,ws-api}/*`,
`features/environments/set-variable-dialog.tsx`, `features/runner/runner-tab.tsx`,
`features/explorer/project-actions.ts`, `features/request-editor/views/get-data-dialog.tsx` and
`features/multi-env/multi-env-actions.ts`.

- `useCurrentProjectId(): string | undefined` returns the focused tab's project. When the focused tab has none, it
  returns the last project id that was focused (kept in the store, not persisted).
- `selectActiveEnvironmentId(state, projectId): string | undefined`, and a `useActiveEnvironment(projectId)` hook that
  returns the environment.
- `setActiveEnvironment(projectId, environmentId | null)` in the store.
- Every reader above switches to the hook with **its own** project id (the editor's request's project, not the current
  project).
- `useMultiEnvState` lists `environmentsForProject` for the request's project.
- Tests: current-project fallback; each hook per project; the multi-env list is filtered.

## Task 5: renderer — switcher, editor, view, remove dialog

Files: `features/environments/{env-switcher,environment-page,environments-view,endpoints-table}.tsx`, the
remove-project dialog.

- Switcher:
  - Labelled with the current project's name.
  - Groups *All projects*, then the current project's name, with a group hidden when empty. Then *No environment*
    and *Manage environments…*.
  - Disabled, showing "No project", when `useCurrentProjectId()` is undefined (review focus 5).
  - `cycleEnvironment` / `env.next` walks the same list.
- Environment page:
  - **Applies to: All projects | Selected projects** with a project multi-select. Switching to All sends
    `projects: null`; unticking every project is allowed and sends `[]`.
  - The *Active* toggle acts for the current project and is disabled, with a tooltip, when out of scope.
  - `workspaceRows` (230-290) lists only projects in scope.
- Environments view: project chips on scoped rows; *No project* for `[]`.
- Remove-project dialog: names the environments that will be left with no project (from the Task 3 reply, or a
  pre-check in the renderer using the same rule).
- Tests: switcher groups with and without scoped environments; label; disabled state; `env.next` order; *Applies to*
  sends the right patch for All, two projects and none; Active toggle disabled; endpoints rows filtered; chips; dialog
  text.

## Task 6: CLI and MCP

Files: `packages/cli/src/ops/{environment,project}.ts`, `packages/cli/src/commands/mcp.ts`, the MCP tool description
builders in `ops/contract-tools.ts` / `ops/send.ts`.

- `pickEnvironment` takes the project id and matches only `environmentsForProject`. If a name matches an environment
  that is out of scope, it fails `environment-out-of-scope` (exit 2), listing the in-scope names.
- `environment-required` only when the project has at least one environment in scope.
- MCP: the `environment` argument goes through the same pick. Descriptions that list environments list only those in
  scope.
- Tests: `run`/`call` with an out-of-scope `--env` (exit 2, message lists names); required vs optional; MCP refusal
  and description filtering.

## Task 7: docs, e2e, changelog

- `guides/environments.mdx`: scope, the switcher per project, CLI behaviour.
- CLI reference: the new exit-2 case for `--env`.
- CHANGELOG under [Unreleased].
- E2E `e2e/specs/environments-scope.spec.ts`:
  1. Two projects; scope `Billing sandbox` to A.
  2. A project B request does not offer it.
  3. Pick it on A, focus a B tab: the switcher shows B's pick.
  4. Focus A again: it shows `Billing sandbox`.
  5. Remove A: the environment shows *No project*.
- Run e2e only in CI (no local Electron windows); locally run the build plus `pnpm check`.
