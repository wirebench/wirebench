# Plan: Wirebench workspaces

Spec: `docs/specs/2026-09-11-wirebench-workspaces-design.md` (approved 2026-09-11 with the §16 defaults). Section refs (§n) point at that spec; "v1 §n" points at `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`.
Executors: superpowers:subagent-driven-development (fresh subagent per task, review between tasks). Tick boxes as tasks land. One commit set per task, Conventional Commits, no `Co-Authored-By` trailer, `pnpm check` green before every commit, all three OSes green in CI at every checkpoint.

**Goal:** a workspace layer above projects, managed in app data: the user creates or picks a workspace, every project in it is loaded at once, environments and a property scope live at workspace level, nothing ever asks for a folder in the normal flow.
**Architecture:** `packages/engine/src/workspace/` (pure model, files, environment linking, id rewriting) ← `apps/desktop/src/main/workspace-service.ts` owning one `ProjectHost` (today's `ProjectService`) per project and routing entity-addressed IPC by a ULID → project index ← additive `workspace.*` channels and `projectId` on the project-lifecycle channels ← renderer `useWorkspaceStore` + a multi-project `useProjectStore` with the same flattened `interfaces`/`requests` indexes editors already consume.
**Stack:** unchanged from v1 §3. No new runtime dependency.

## Global constraints (every task inherits)

- Everything in v1 plan "Global constraints", v1 §12, ADR-0003, ADR-0004, ADR-0005.
- The renderer never sends a filesystem path. Link / import / export / locate run their native dialog in main and record the pick in `DialogPicks`. Any new channel with a `path` field is a defect.
- Project format stays `formatVersion: 1`; a project folder inside a workspace is byte-identical to a standalone one. Workspace files carry their own `formatVersion: 1`; any additive field bumps it (ADR-0003 discipline).
- Deletion is trash-only (`shell.trashItem`, e2e hook `WIREBENCH_E2E_TRASH_DIR`), always after a confirmation, never for linked folders. No `rm -rf` under `userData` or a linked root.
- Entity ids (project, interface, request, environment, keystore, WSS config) are ULIDs and globally unique inside an open workspace: imports re-identify, links refuse duplicates.
- Deterministic serialization (`stringifyYaml`, sorted keys, `writeFileAtomic`) for `workspace.yaml` and `environments/*.yaml`.
- UI copy says *workspace* and *project*; never *collection*; never names other tools (`pnpm check:banned-terms`).
- Ask first: new runtime deps; project `formatVersion` bump; IPC removals beyond §5 of the spec; CI/release changes; multi-window; any sync/sharing.
- Never block the renderer on hydration or startup on a broken workspace: the picker shows the error.

## Order & rationale

```
W0 engine        1 → 2 → 3                                   (pure, TDD, no desktop change)
W1 main          4 (behaviour-neutral rename + multi-file history, full e2e green)
                 → 5 (WorkspaceService core) → 6 (project ops) → 7 (environments + routing)
W2 skeleton      8 (IPC contract + main wiring + renderer stores) → 9 (picker, new project, e2e migration)   = pushed together
W3 UI            10 (switcher, manage, commands, per-workspace tabs) → 11 (explorer roots + project ops UI + import target)
                 → 12 (environments grid + status bar) → 13 (cross-project views)
W4 ship          14 (workspace e2e + perf + screenshots) → 15 (docs, ADR-0006, cleanup)
```

- Engine first: the file format, scope chain and endpoint precedence are the contract everything else types against, and they test without Electron.
- Task 4 is the risk reducer: rename the single-project owner into a per-project host with **zero behaviour change** and the whole e2e suite green, before any workspace code touches it.
- Tasks 8 and 9 are the walking skeleton. Task 8 changes the contract and stores; the app has no way to create a workspace from the UI until Task 9 lands, so they are pushed to CI together (ledger note), each still `pnpm check` green.
- UI features (W3) are independent of each other after the skeleton and can be reviewed as separate diffs.
- Checkpoints map to spec §13 success criteria (SC#).

## Names later tasks depend on (define once, reuse verbatim)

```ts
// @wirebench/engine — packages/engine/src/workspace/*.ts (T1–T3), exported from src/index.ts under a `// Workspace` banner
export const WORKSPACE_FORMAT_VERSION = 1;
export interface WorkspaceProjectRef { readonly id: string; readonly slug: string; readonly source: 'internal' | 'linked'; readonly path?: string }   // path: absolute, linked only
export interface WorkspaceEnvironment { readonly id: string; readonly name: string; readonly slug: string; readonly order: number; readonly properties: PropertyMap; readonly endpoints: Readonly<Record<string, string>> } // key `<projectSlug>/<interfaceSlug>`
export interface Workspace { readonly formatVersion: 1; readonly id: string; readonly name: string; readonly description?: string; readonly createdAt: string; readonly properties: PropertyMap; readonly activeEnvironmentId?: string; readonly projects: readonly WorkspaceProjectRef[]; readonly environments: readonly WorkspaceEnvironment[] }
createWorkspace(name: string, options?: CreateOptions & { readonly now?: () => Date }): Workspace
createWorkspaceEnvironment(name: string, taken: ReadonlySet<string>, options?: CreateOptions): WorkspaceEnvironment
WORKSPACES_DIR = 'workspaces' · WORKSPACE_MANIFEST = 'workspace.yaml' · WORKSPACE_ENVIRONMENTS_DIR = 'environments' · WORKSPACE_PROJECTS_DIR = 'projects' · WORKSPACE_STATE_FILE = 'workspace-state.json'
workspaceDir(userDataDir, workspaceId) · workspaceManifestFile(dir) · workspaceEnvironmentFile(dir, slug) · workspaceProjectDir(dir, slug)
loadWorkspace(dir: string, options?: { fs?: FsLike }): Promise<{ workspace: Workspace; problems: readonly WorkspaceProblem[] }>   // WorkspaceProblem {code: 'environment-file-invalid' | 'project-ref-invalid'; message; file}
workspaceFiles(workspace: Workspace, options?: { writer?: string }): WorkspaceFiles   // ReadonlyMap<relativePath, content>
saveWorkspace(workspace: Workspace, dir: string, options?: { fs?: FsLike; previous?: WorkspaceFiles; writer?: string }): Promise<SaveResult>
migrateWorkspace(document: unknown, file: string): Record<string, unknown>
reidentifyProject(project: Project, newId?: IdGenerator): Project                                   // T2
linkedEnvironment(project: Project, workspaceEnv: WorkspaceEnvironment | undefined): Environment | undefined   // T3, by slug
resolveWorkspaceEndpoint(input: { workspace: Workspace; project: Project; projectSlug: string; iface: Interface; request: Pick<RequestDef, 'endpointId' | 'endpointUrl'> }): { url: string | undefined; source: EndpointSource; endpoint?: Endpoint }   // EndpointSource gains 'workspace-environment'
resolveWorkspaceScopes(input: { workspace: Workspace; project: Project; globals: PropertyMap; system?: PropertyScopes['system'] }): PropertyScopes
// properties.ts: PropertyScopes gains `readonly workspace?: PropertyMap`; SCOPE_NAMES + 'Workspace'; shorthand chain Env → Project → Workspace → Global
// errors.ts: class WorkspaceError extends WirebenchError; codes: workspace-not-found · workspace-file-invalid · workspace-format-too-new · workspace-path-invalid · project-already-in-workspace · project-not-in-workspace · project-folder-missing

// apps/desktop/src/main (T4–T7)
class ProjectHost            // = today's ProjectService, file main/project-host.ts, unchanged API, one instance per project
class HistoryService         // open(projectId) adds a file to a Map; close(projectId); closeAll(); list(query & { projectId? }) merges newest-first; recordSend routes by projectId
class WorkspaceService {     // main/workspace-service.ts
  constructor(deps: WorkspaceServiceDeps)   // { userDataDir, engine, globals, secrets, preferences, picks, resolveSystemProxy, history, hooks, trash?: (path: string) => Promise<void>, fs?: FsLike, now?: () => Date }
  list(): Promise<WorkspaceSummaryWire[]>; create(name): Promise<WorkspaceWire>; open(id): Promise<WorkspaceWire>; openLast(): Promise<WorkspaceWire | null>; close(): Promise<null>
  snapshot(): WorkspaceWire | null; rename(id, name): Promise<WorkspaceSummaryWire[]>; delete(id): Promise<WorkspaceSummaryWire[]>
  addProject(name): Promise<{ workspace: WorkspaceWire; projectId: string }>; removeProject(projectId, options: { deleteFiles: boolean }): Promise<WorkspaceWire>
  linkProject(sender): Promise<WorkspaceWire | null>; importProjectFolder(sender): Promise<WorkspaceWire | null>; exportProject(projectId, sender): Promise<{ dir: string } | null>; locateProject(projectId, sender): Promise<WorkspaceWire | null>
  setActiveEnvironment(environmentId: string | null): Promise<WorkspaceWire>; mutate(change: WorkspaceChange): Promise<{ workspace: WorkspaceWire; createdEnvironmentId?: string }>
  hostFor(projectId): ProjectHost; hostOfEntity(entityId): ProjectHost; hosts(): readonly ProjectHost[]; saveAll(reason): Promise<void>
}
interface WorkspaceHooks { onChanged(workspace: WorkspaceWire | null); onProjectChanged(projectId, project: ProjectWire | null); onProjectChangedOnDisk(projectId, paths); onHydration(projectId, event); onProgress(event) }
interface ProjectRouter      // main/project-router.ts: the union of every `Pick<ProjectService, …>` the ipc/*.ts modules declare, re-expressed so each method resolves its host from the entity id it already receives; methods with no entity id (`snapshot`, `scopesFor`, `projectId`, `save`) take `projectId` (or `requestId` for scopesFor). WorkspaceService implements it.

// IPC — apps/desktop/src/shared/ipc.ts (renderer: window.wirebench.workspace.<verb>())   (T8)
workspace.{list, create, open, close, snapshot, rename, delete, addProject, linkProject, importProjectFolder, exportProject, locateProject, removeProject, setActiveEnvironment, mutate}
project.{snapshot, mutate, save, addInterface, reload}   — every request carries projectId: string; addInterface takes target: { projectId } | { newProjectName }; create/open/close/recent REMOVED
history.list  + projectId?: string · search.query matches + projectId, projectName
events: workspace.changed { workspace: WorkspaceWire | null } · project.changed { projectId, project: ProjectWire | null } · project.changedOnDisk { projectId, paths } · project.hydration { projectId, interfaceId, status, message? }
// wire types — apps/desktop/src/shared/wire-types.ts
WorkspaceSummaryWire { id, name, dir, projectCount, createdAt, lastOpenedAt?, unreadable?: boolean }
WorkspaceProjectWire { id, name, slug, source: 'internal' | 'linked', dir, status: 'loading' | 'ready' | 'missing' | 'error', message? }
WorkspaceEnvironmentWire { id, name, slug, order, properties, endpoints }
WorkspaceWire { id, name, description?, dir, properties, environments: WorkspaceEnvironmentWire[], activeEnvironmentId?, projects: WorkspaceProjectWire[] }
WorkspaceChange = rename-workspace {name} | set-workspace-property {name, value} | remove-workspace-property {name} | add-workspace-environment {name} | update-workspace-environment {environmentId, patch: {name?, properties?, endpoints?}} | remove-workspace-environment {environmentId}

// renderer (T8+)
useWorkspaceStore   // state/workspace.ts: { workspace: WorkspaceWire | null; workspaces: WorkspaceSummaryWire[]; status: 'idle' | 'loading' | 'error'; error?: IpcError } + one action per workspace.* channel + subscribeToWorkspace()
useProjectStore     // state/project.ts: { projects: Record<projectId, ProjectWire>; interfaces; requests; order: readonly { projectId; interfaceIds: string[] }[]; projectOf: Record<entityId, projectId>; keystores/wssOutgoing/wssIncoming (each item + projectId); saveStatus: Record<projectId, SaveStatus>; changedOnDisk: Record<projectId, string[]> }
                    // actions that address an entity keep their signature; the rest gain a leading projectId: importDefinition(target, source, options?, token?), updateProjectSettings, setProjectProperty, removeProjectProperty, addKeystore, addWssOutgoing, addWssIncoming, addEnvironment/updateEnvironment/removeEnvironment (linked projects only), reloadProject, save(projectId?)
                    // setActiveEnvironment moves to useWorkspaceStore
testids: workspace-picker · workspace-picker-row · workspace-create-name · workspace-create · workspace-import-folder · workspace-switcher · workspace-switcher-item · workspace-manage-dialog · workspace-rename-name · workspace-delete · workspace-delete-confirm · explorer-new-project · new-project-dialog · new-project-name · new-project-create · explorer-project-row[data-project-id] · explorer-project-linked-badge · explorer-project-missing · remove-project-dialog · remove-project-confirm · import-target-project · workspace-env-grid · workspace-env-cell · env-switcher · history-project-filter · editor-empty
commands: workspace.create · workspace.switch · workspace.manage · workspace.newProject (Mod+Shift+N) · workspace.linkProject · workspace.importProjectFolder · workspace.exportProject · workspace.removeProject · project.save (Mod+S, saves all) · env.switch / env.next (workspace environments)   — project.new / project.open / project.close REMOVED; CommandCategory + 'Workspace'; COMMAND_WHEN_SCOPES + 'workspace'
e2e helpers (e2e/helpers/project.ts): createWorkspace(page, name = 'Workspace 1') · createProject(page, name) · createProjectWithCalculator(page, server, options?) = createWorkspace + createProject(options?.expectProjectName ?? 'Calculator Project') + import; launchApp keeps `folderDialogPath` (link/import/export only) and gains `trashDir` → WIREBENCH_E2E_TRASH_DIR
```

## Tasks

### W0 — Engine

- [ ] **1. Workspace model, schema, files**
  - `workspace/model.ts` (types above, `createWorkspace` with `createdAt` from `now`, `createWorkspaceEnvironment` slugging through `slugify`/`uniqueSlug`), `workspace/schema.ts` (`workspaceManifestSchema` = `z.looseObject` with `formatVersion: z.literal(1)`, `projects: z.array(z.discriminatedUnion('source', …))`, `workspaceEnvironmentFileSchema` mirroring `environmentFileSchema`; parsed through the existing `parseFile`), `workspace/paths.ts` (constants + builders above; every slug through `assertPathSegment`), `workspace/serialize.ts` (`workspaceFiles`: `workspace.yaml` + `environments/<slug>.yaml`, `stringifyYaml`, `compact`), `workspace/load.ts` (`loadWorkspace`: manifest → `migrateWorkspace` → schema; environments from the directory walk with slug = file name, sorted `byOrder`; a bad environment file is a `WorkspaceProblem`, not a throw), `workspace/save.ts` (`saveWorkspace` = write changed files atomically, remove managed `environments/*.yaml` no longer present, same `SaveResult` shape as `saveProject`), `workspace/migrate.ts` (no-op at 1; newer → `workspace-format-too-new`), `WorkspaceError` in `errors.ts`, exports in `index.ts`.
  - Acceptance: model → folder → model deep-equal; `workspace.yaml` byte output pinned by inline snapshot (sorted keys, `lineWidth: 0`); renaming one environment changes exactly one file and removes the old one; slug `../x` → `workspace-path-invalid`; missing dir → `workspace-not-found`; `formatVersion: 2` → `workspace-format-too-new`; corrupt environment file → problem, workspace still loads.
  - Verify: `pnpm vitest run packages/engine/test/unit/workspace/roundtrip`
  - Files: packages/engine/src/workspace/{model,schema,paths,serialize,load,save,migrate,index}.ts, packages/engine/src/errors.ts, packages/engine/src/index.ts, packages/engine/test/unit/workspace/{fixture,roundtrip}.test.ts

- [ ] **2. `reidentifyProject`**
  - `workspace/reidentify.ts`: new ULIDs for the project and every interface, endpoint, request, environment, WSS outgoing/incoming config and keystore entry; every internal reference rewritten (`Interface.defaultEndpointId`, `RequestDef.endpointId`, `wssOutgoingRef`/`wssIncomingRef`, `activeEnvironmentId`, keystore references inside the opaque `WssRef.document` bags — walk the document for values equal to an old id); `secretRef`s and attachment `sha256` sources untouched; deterministic under an injected `IdGenerator`.
  - Acceptance: no old id survives anywhere in `projectFiles(reidentified)` (string search of every file); every reference resolves in the new model; `passwordRef`/`passwordSecretRef` values identical before and after; idempotent structure (second pass changes only ids).
  - Verify: `pnpm vitest run packages/engine/test/unit/workspace/reidentify`
  - Files: packages/engine/src/workspace/reidentify.ts, packages/engine/src/index.ts, packages/engine/test/unit/workspace/reidentify.test.ts

- [ ] **3. Workspace scope, environment linking, endpoint precedence**
  - `properties.ts`: `PropertyScopes.workspace?`, `SCOPE_NAMES` + `Workspace`, `lookupInScope('Workspace')`, shorthand chain Env → Project → Workspace → Global (System still explicit only). `workspace/environments.ts`: `linkedEnvironment` (project environment whose `slug` equals the active workspace environment's slug), `resolveWorkspaceScopes` (env map = `{...workspaceEnv.properties, ...linkedProjectEnv.properties}` so the project value wins; `workspace` = workspace properties), `resolveWorkspaceEndpoint` (precedence: linked project env `endpoints[iface.slug]` → workspace env `endpoints[`${projectSlug}/${iface.slug}`]` → the existing request-custom / request-endpoint / interface-default chain; environment layers name no `Endpoint`, so `resolveAuthEndpoint` is unchanged).
  - Acceptance: table tests for `${#Workspace#x}`, shorthand order, project-wins on the same key for properties and endpoints, no linked env → workspace env applies, no env at all → existing behaviour byte-for-byte (`resolveEndpoint` tests still pass untouched).
  - Verify: `pnpm vitest run packages/engine/test/unit/project/properties packages/engine/test/unit/workspace/environments`
  - Files: packages/engine/src/project/properties.ts, packages/engine/src/workspace/environments.ts, packages/engine/src/index.ts, packages/engine/test/unit/project/properties.test.ts, packages/engine/test/unit/workspace/environments.test.ts

**Checkpoint W0:** engine coverage still ≥ 85%; `pnpm check` green; no desktop file touched.

### W1 — Main process

- [ ] **4. `ProjectHost` rename and multi-file history (behaviour-neutral)**
  - `git mv main/project-service.ts main/project-host.ts`, class `ProjectHost`, no logic change; every importer and `Pick<ProjectService, …>` type updated; `apps/desktop/test/project-service.test.ts` → `project-host.test.ts`. `HistoryService`: `Map<projectId, HistoryFile>` (`open` adds, `close(projectId)`, `closeAll()`, `list(query)` merges across open files newest-first with `projectId` filter, `recordSend` routes by id, `get` searches all); `index.ts` hooks call `open`/`close(projectId)` — one project still, so behaviour is identical.
  - Acceptance: `pnpm test` and the **full** `pnpm test:e2e` green with no spec changed; `history-service.test.ts` gains a two-projects-open case (append to both, merged list order, close one keeps the other).
  - Verify: `pnpm check && pnpm test:e2e`
  - Files: apps/desktop/src/main/{project-host.ts,history-service.ts,index.ts,ipc/*.ts}, apps/desktop/test/{project-host,history-service,ipc-history}.test.ts

- [ ] **5. `WorkspaceService` core**
  - `main/workspace-state.ts` (`<userData>/workspace-state.json` `{ version: 1, lastOpenedWorkspaceId }`, atomic, corrupt → empty). `main/workspace-service.ts`: `list()` = scan `<userData>/workspaces/*/workspace.yaml` (unreadable manifest → `unreadable: true` row, never dropped; `lastOpenedAt` from the state file history map), `create(name)` (ULID folder, manifest, `projects/` dir), `open(id)` (close current → `loadWorkspace` → one `ProjectHost` per ref, internal refs `openProject(workspaceProjectDir)`, linked refs `openProject(path)` when the folder exists else `status: 'missing'`; hosts open sequentially, hydration stays each host's background job; `entityId → projectId` index rebuilt from each host's snapshot on every `onProjectChanged`), `openLast()`, `close()` (`saveAll('close')`, stop hosts, `history.closeAll()`), `rename`, `delete` (`trash(dir)` after the renderer's confirmation; default `trash` = `shell.trashItem`, e2e `WIREBENCH_E2E_TRASH_DIR` moves the folder there), `snapshot()` → `WorkspaceWire` with per-project status, `saveAll(reason)`. `main/project-router.ts`: the `ProjectRouter` interface; `WorkspaceService` implements it (`hostOfEntity` throws `WirebenchError('unknown-entity')`).
  - Acceptance (temp `userData`, real `EngineService`, calculator fixture server): create → list → openLast round-trip; two internal projects open with independent hosts and both history files; corrupt manifest listed unreadable; delete moves to the trash dir and drops it from the list; `hostOfEntity(requestId)` finds the right host; closing saves dirty hosts (`deferredWriteFs` pattern).
  - Verify: `pnpm vitest run apps/desktop/test/workspace-service apps/desktop/test/workspace-state`
  - Files: apps/desktop/src/main/{workspace-service.ts,workspace-state.ts,project-router.ts}, apps/desktop/test/{workspace-service,workspace-state}.test.ts

- [ ] **6. Project operations**
  - `addProject(name)` (`uniqueSlug` over existing slugs, `createProject`, `saveProject` into `projects/<slug>`, host opened, ref appended, manifest saved); `removeProject(projectId, {deleteFiles})` (host closed, `history.close`, ref removed; internal + `deleteFiles` → `trash(dir)`; linked → never touches files); `linkProject(sender)` (`pickFolder` in main, `rememberRead`, folder must load as a project else `project-folder-missing`/`project-file-invalid`; id already present → `project-already-in-workspace` with `details.projectId`); `importProjectFolder(sender)` (pick → `loadProject` → `reidentifyProject` → `saveProject` into `projects/<slug>` → copy `attachments/` and `interfaces/*/definition/` byte-for-byte); `exportProject(projectId, sender)` (`pickFolder` as a write pick; refuse a non-empty target; `saveProject` + the same copies); `locateProject(projectId, sender)` (re-point a missing linked ref).
  - Acceptance: link of an exported copy works, link of the same folder twice → `project-already-in-workspace`; import of a copy coexists with its source (no shared entity id — asserted by index); remove internal → folder in trash dir, linked → folder untouched; export → `loadProject(target)` deep-equals; every operation records/uses picks and never accepts a path argument.
  - Verify: `pnpm vitest run apps/desktop/test/workspace-projects`
  - Files: apps/desktop/src/main/workspace-service.ts, apps/desktop/src/main/native-dialogs.ts, apps/desktop/test/workspace-projects.test.ts

- [ ] **7. Environments, properties and routing in main**
  - `WorkspaceService.mutate(change)` (rename, properties, environment add/update/remove with `createWorkspaceEnvironment`, patch replaces maps like `EnvironmentPatchWire`), `setActiveEnvironment`; `ProjectHost` gains an injected `workspaceContext: () => { workspace: Workspace; projectSlug: string } | undefined` and uses `resolveWorkspaceScopes`/`resolveWorkspaceEndpoint` when it is defined (`scopesFor`, `sendInputFor`, the expansion preflight, `endpoint-env-badge` source); search corpus = every host's snapshot with `projectId`/`projectName` on each document; `history.list` honours `projectId`.
  - Acceptance: with `dev` active and an endpoint override `calc/Calculator` the send goes to the override (fixture server receives it); a linked project's own `dev` value wins over the workspace's for the same property; `${#Workspace#region}` expands in a header; unresolved `${#Workspace#missing}` appears in the preflight problems; search returns matches from two projects with the right `projectId`.
  - Verify: `pnpm vitest run apps/desktop/test/workspace-environments apps/desktop/test/ipc-search apps/desktop/test/ipc-history`
  - Files: apps/desktop/src/main/{workspace-service.ts,project-host.ts,ipc/search.ts,search.ts,ipc/history.ts}, apps/desktop/test/{workspace-environments,ipc-search,ipc-history}.test.ts

**Checkpoint W1:** SC5 (remove/trash), SC6 (link refusal), SC7 (no secrets in a workspace folder — grep test in T5) proven at unit level; existing e2e still green (the UI still runs the single-project path until T8).

### W2 — Walking skeleton

- [ ] **8. IPC contract, main wiring, renderer stores**
  - `shared/ipc.ts` + `wire-types.ts`: the `workspace.*` channels, events and wire types from the names block; `project.*` requests gain `projectId` (`addInterface` takes `target`); `project.create/open/close/recent` removed. `main/ipc/workspace.ts` (new), `main/ipc/project.ts` (route by `projectId`), `main/index.ts` (construct `WorkspaceService`, pass it as the `ProjectRouter` to every `register*Channels`, broadcast the new events, `before-quit` → `saveAll('quit')`, startup `openLast()` after preferences are ready). Renderer: `state/workspace.ts` + `subscribeToWorkspace()`; `state/project.ts` re-shaped as in the names block (indexes flattened across projects; optimistic `pending` maps unchanged; `project.changed` applies one project; `null` removes it); `state/history.ts` reloads on `workspace.changed`; editors/exchanges/interface-editor stores get a `reset()` called from `useWorkspaceStore.applySnapshot(null)`; `useUiStore.envSwitcherOpen` unchanged. Every existing renderer call site compiles against the new signatures; `EditorArea` shows `editor-empty` instead of the Welcome screen when no tab is active; `AppShell` renders `<WorkspacePicker />` (a stub in this task: list + create by name, testids `workspace-picker`/`workspace-create-name`/`workspace-create`) when `workspace === null`. `test/mocks/wirebench-api.ts` gains the `workspace` domain.
  - Acceptance: `pnpm check` green (typecheck, lint, unit); `apps/desktop/test/renderer/project-store.test.ts` covers two projects (indexes merged, removal of one keeps the other, `projectOf`); `ipc-workspace.test.ts` covers every channel through the handler-capture pattern; e2e is expected red until T9 (ledger note, no push).
  - Verify: `pnpm check`
  - Files: apps/desktop/src/shared/{ipc.ts,wire-types.ts}, apps/desktop/src/main/{index.ts,ipc/workspace.ts,ipc/project.ts}, apps/desktop/src/renderer/state/{workspace.ts,project.ts,history.ts,editors.ts,exchanges.ts}, apps/desktop/src/renderer/shell/{app-shell.tsx,editor-area.tsx}, apps/desktop/src/renderer/features/workspace/picker-screen.tsx, apps/desktop/test/{ipc-workspace.test.ts,mocks/wirebench-api.ts,renderer/project-store.test.ts,renderer/workspace-store.test.ts}

- [ ] **9. Picker, new project by name, e2e migration**
  - `features/workspace/picker-screen.tsx` finished: full-window screen under the title bar; rows `workspace-picker-row` (name, project count, last opened; unreadable rows disabled with *Reveal*), create form (`workspace-create-name`, Enter or `workspace-create`), `workspace-import-folder` (calls `workspace.importProjectFolder` after creating/choosing a workspace; suggestions from a leftover `recent-projects.json` via a read-only `workspace.list`-side field `suggestions`), error banner when `openLast` failed. `features/workspace/new-project-dialog.tsx` (name only; `explorer-new-project` toolbar button and `workspace.newProject` command open it; existing `new-project-*` testids kept). `features/welcome/` deleted; `NewProjectDialog` in `features/explorer` deleted. e2e: `launch-app.ts` (`trashDir`), `helpers/project.ts` (`createWorkspace`, `createProject`, `createProjectWithCalculator` rewritten), every spec that clicked `welcome-*` (walking-skeleton, keyboard, secrets, interface-editor, packaged, project, a11y, screenshots) moved to the helpers; `project.spec.ts` "Recent" case becomes "relaunch reopens the last workspace"; a11y/docs screenshots regenerated on macOS in a dedicated commit.
  - Acceptance: full `pnpm test:e2e` green on the developer machine; no `folderDialogPath` is needed by any spec except link/import/export ones (none yet); `welcome` strings gone from src and e2e.
  - Verify: `pnpm check && pnpm test:e2e`
  - Files: apps/desktop/src/renderer/features/workspace/{picker-screen.tsx,new-project-dialog.tsx,workspace-actions.ts}, apps/desktop/src/renderer/shell/{app-shell.tsx,editor-area.tsx}, apps/desktop/src/main/workspace-service.ts, e2e/helpers/{launch-app.ts,project.ts}, e2e/specs/*.spec.ts, e2e/specs/__screenshots__/**, docs/images/*.png, apps/desktop/test/renderer/{picker-screen,new-project-dialog}.test.tsx

**Checkpoint W2 (push T8+T9 together):** SC1, SC2 (two projects, tabs across them — asserted in T14 but exercised here), SC8 partial (all previously green e2e green on three OSes in CI).

### W3 — UI

- [ ] **10. Switcher, manage dialog, commands, per-workspace tabs**
  - `shell/title-bar.tsx`: `wirebench · <name> ▾` → `workspace-switcher` dropdown (workspaces by last opened, `workspace-switcher-item`, *Create workspace…*, *Manage workspaces…*). `features/workspace/manage-dialog.tsx` (`workspace-manage-dialog`: rename inline `workspace-rename-name`; delete → `workspace-delete` → confirm `workspace-delete-confirm` naming the internal project count → `workspace.delete`). `commands/register-workspace-commands.ts` (ids from the names block; `project.new/open/close` removed from `register-project-commands.ts`; `CommandCategory` + `'Workspace'`, `COMMAND_WHEN_SCOPES` + `'workspace'`; shortcuts editor and app menu pick them up). `state/ui-state.ts` `UI_STORAGE_VERSION = 3` with `workspaces: Record<workspaceId, { tabs: PersistedTab[]; activeId?: string; sidebarView }>` where `PersistedTab` = `{ kind: 'request' | 'interface' | 'environment'; id }`; `useWorkspaceStore.applySnapshot` restores tabs whose ids still resolve and drops the rest; switching saves the outgoing set. Extract `components/confirm-dialog.tsx` from the six inline `AlertDialog` copies and use it here (the others migrate opportunistically, not required).
  - Acceptance: component tests for switcher/manage/confirm; keyboard-only switch via palette (`workspace.switch` with a name argument); tabs restored after a switch round-trip (store test); `Mod+Shift+N` opens the new-project dialog.
  - Verify: `pnpm vitest run --project desktop`; `pnpm test:e2e -- --grep keyboard`
  - Files: apps/desktop/src/renderer/shell/title-bar.tsx, apps/desktop/src/renderer/features/workspace/{switcher.tsx,manage-dialog.tsx}, apps/desktop/src/renderer/components/confirm-dialog.tsx, apps/desktop/src/renderer/commands/{register-workspace-commands.ts,register-project-commands.ts,register-shell-commands.ts}, apps/desktop/src/shared/commands.ts, apps/desktop/src/renderer/state/{ui-state.ts,ui.ts,workspace.ts}, apps/desktop/test/renderer/{workspace-switcher,manage-dialog,ui-state-workspaces}.test.tsx

- [ ] **11. Explorer project roots, project operations UI, import target**
  - `features/explorer/tree-nodes.ts`: node ids prefixed `proj:<projectId>` → `iface:…` unchanged under it; `ExplorerNodeKind` + `'project'`; `buildExplorerTree(order, interfaces, requests, projects)` renders one root per `WorkspaceProjectWire` (link badge `explorer-project-linked-badge` with the path as tooltip; `explorer-project-missing` row with *Locate…* / *Remove*; hydration spinner from status). Context menu on a project root: Import WSDL… (opens the import dialog with the target preselected), New request… stays on operations, Rename (inline, `project.mutate rename-project`), Settings… (opens the project settings tab), Reveal in Finder/Explorer (`fs.reveal` via a new main-side `workspace.revealProject {projectId}` — main knows the path), Export project…, Remove from workspace (linked → unlink; internal → `remove-project-dialog` with `remove-project-confirm` → `deleteFiles: true`). Empty workspace state: "Create a project or import a WSDL" with both buttons. `import-dialog.tsx`: `import-target-project` select (existing projects + *New project "<name>"*, default = selected project, else new when the workspace is empty); the inline "needs project" prompt removed.
  - Acceptance: component tests for tree building with two projects and a missing linked one; context-menu items per kind; import dialog submits `{ target: { newProjectName } }` when chosen; e2e in T14 covers the rest.
  - Verify: `pnpm vitest run --project desktop`
  - Files: apps/desktop/src/renderer/features/explorer/{tree-nodes.ts,explorer-view.tsx,context-menu.tsx,explorer-actions.ts,import-dialog.tsx,project-actions.ts}, apps/desktop/src/renderer/commands/register-explorer-commands.ts, apps/desktop/src/main/{ipc/workspace.ts,workspace-service.ts}, apps/desktop/src/shared/ipc.ts, apps/desktop/test/renderer/{tree-nodes,explorer-view,import-dialog}.test.tsx

- [ ] **12. Workspace environments grid and status bar**
  - `features/environments/workspace-environments.tsx`: the sidebar Environments section lists workspace environments (add/rename/duplicate/delete/set active through `workspace.mutate`/`setActiveEnvironment`); the environment tab becomes a grid (`workspace-env-grid`): rows = every interface of every project (`project › interface`), columns = environments, cells `workspace-env-cell` editing `endpoints["<projectSlug>/<interfaceSlug>"]` with a datalist of that interface's declared endpoints and the effective source shown on hover (workspace / project / interface); properties table below with `${#Workspace#…}` hints. `env-switcher.tsx` reads `useWorkspaceStore` (`No environment`, environments, *Manage environments…*). Linked projects keep the existing per-project environment editor, reachable from the project root's context menu and labelled *Project environments (linked project)*; internal projects hide it. Details panel: *Workspace properties* tab next to *Global properties*.
  - Acceptance: component tests: grid edit produces `update-workspace-environment` with the right key; switcher sets the workspace environment; `endpoint-env-badge` shows for a workspace override; e2e in T14.
  - Verify: `pnpm vitest run --project desktop`
  - Files: apps/desktop/src/renderer/features/environments/{workspace-environments.tsx,environment-grid.tsx,env-switcher.tsx,environments-section.tsx,environment-editor.tsx}, apps/desktop/src/renderer/shell/{status-bar.tsx,details-panel.tsx}, apps/desktop/src/renderer/features/properties/workspace-properties.tsx, apps/desktop/test/renderer/{environment-grid,env-switcher,workspace-properties}.test.tsx

- [ ] **13. Cross-project views**
  - Search results grouped `project › interface › request`; quick open entries prefixed with the project name and keyed `request:<id>` unchanged; Problems rows labelled `project › interface › …`; details breadcrumb `project › interface › operation › request`; History view merged newest-first with `history-project-filter` (all / one project) calling `history.list({ projectId })`; `changed-on-disk-banner` per project (names the project).
  - Acceptance: component tests per view with two projects in the store; History filter test; no view reads `projects[0]` implicitly (grep in review).
  - Verify: `pnpm vitest run --project desktop`
  - Files: apps/desktop/src/renderer/features/{search/search-view.tsx,problems/problems-view.tsx,history/history-view.tsx,project/changed-on-disk-banner.tsx}, apps/desktop/src/renderer/shell/{quick-open.ts,details-panel.tsx}, apps/desktop/src/renderer/state/history.ts, apps/desktop/test/renderer/{search-view,problems-view,history-view,quick-open}.test.tsx

**Checkpoint W3:** SC3 (environment override + `${#Workspace#}` + project-wins), SC4 (relaunch + switch restore) demonstrable by hand; unit/component green.

### W4 — Ship

- [ ] **14. Workspace e2e, performance budget, screenshots**
  - `e2e/specs/workspace.spec.ts`: picker → create → new project → import Calculator into it → import a second WSDL as a new project → open a request from each (two tabs) → send both → add `dev`, override one interface's endpoint to a second server, activate → send hits the second server only → relaunch reopens the workspace with both tabs → create a second workspace, switch, switch back (tabs restored) → remove the internal project (folder present in `trashDir`) → export the other project, create a workspace, link the export (works) and link it again (refused with a readable toast) → manage dialog deletes the first workspace. `perf.spec.ts`: seed 10 internal projects × 3 interfaces on disk with the engine's `createProject`/`createInterface`/`saveProject` (definitions served by the fixture server), assert picker → explorer interactive < 1.5 s (macOS) / platform-scaled like the existing budgets, and workspace switch < 1 s. Secrets grep test for a saved workspace folder (main unit, added to `workspace-service.test.ts` if T5 did not). Regenerate a11y snapshots and `docs/images` in a dedicated commit.
  - Acceptance: green on macOS locally and on the three CI OSes; the e2e trash dir assertion works on Linux.
  - Verify: `pnpm test:e2e -- --grep "workspace|perf"`
  - Files: e2e/specs/{workspace,perf}.spec.ts, e2e/helpers/{project.ts,seed-workspace.ts}, e2e/specs/__screenshots__/**, docs/images/*.png, apps/desktop/test/workspace-service.test.ts

- [ ] **15. Docs, ADR-0006, cleanup**
  - `docs/adr/0006-workspaces-in-app-data.md` (context: no folder management; decision: workspaces under `userData`, projects inside, linked folders for git, environments at workspace level with name linking, trash-only deletion; consequences: export/link are the git bridges, `formatVersion` on the workspace manifest). README quick start + shortcuts table rewritten (no folder step; workspace switcher); `docs/architecture/overview.md` (WorkspaceService, router, storage layout); `CHANGELOG.md` Unreleased → *Added: workspaces…*, *Removed: open/new project folder*; `docs/success-criteria.md` SC14 row citing the new test paths (the doc-paths gate checks they exist); v1 spec §6.9/§7 get a pointer to the workspaces spec; ADR-0003 one-line note; `docs/roadmap.md` (multi-window, shared environments sync as ideas). Delete `main/recent-projects.ts` + its test once the picker suggestion reads the file through `workspace-service.ts` (T9); delete dead `welcome` tab kind; `pnpm check` incl. banned terms and doc paths.
  - Acceptance: `pnpm check` green; no reference to "open a project folder" remains outside the changelog's Removed entry; ADR index in README updated.
  - Verify: `pnpm check`
  - Files: docs/adr/0006-workspaces-in-app-data.md, README.md, docs/architecture/overview.md, CHANGELOG.md, docs/success-criteria.md, docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md, docs/adr/0003-project-folder-format.md, docs/roadmap.md, apps/desktop/src/main/recent-projects.ts (deleted), apps/desktop/test/recent-projects.test.ts (deleted)

**Checkpoint W4 (final):** all spec §13 criteria SC1–SC10 evidenced in `docs/success-criteria.md`; CI green on three OSes; final whole-branch review.

## Risks

| Risk | Mitigation |
|---|---|
| T8 is the largest diff (contract + stores) and the app is not usable until T9 | Opus implementer; T4 proves the host rename first; T8/T9 pushed together; store tests cover two projects before any UI |
| Stale editor/exchange state across workspace switches (stores never reset today) | `reset()` on every store in T8, tab persistence per workspace in T10, e2e switch round-trip in T14 |
| `DialogPicks` is session-wide: a pick made for project A satisfies a containment check for project B | Accepted (same user, same session, same machine); noted in ADR-0006; per-project scoping is a follow-up if a threat model needs it |
| Hydrating N projects on open | Hosts open sequentially and hydrate in the background as today; explorer renders from manifests; budget asserted in T14 |
| Trash unavailable on CI Linux | `WIREBENCH_E2E_TRASH_DIR` hook; production reports a failed `trashItem` and keeps the folder |
| Name-linked environments confuse | Internal projects have none; the grid shows the effective source per cell |
| Screenshot churn (welcome → picker, title bar) | One dedicated snapshot commit in T9 and T14 on macOS; CI skips screenshot comparisons as before |

## Unresolved questions

None blocking. Two defaults to confirm during review of T11/T12 if they feel wrong in use: the import dialog defaults to the explorer-selected project (else a new project), and the environment grid shows every interface of every project rather than one project at a time.
