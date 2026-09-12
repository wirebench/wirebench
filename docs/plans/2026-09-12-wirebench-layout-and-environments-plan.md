# Plan: Environments view, right panel removal, collapsible panels

Spec: `docs/specs/2026-09-12-wirebench-layout-and-environments-design.md` (approved 2026-09-12 with the §12 defaults and two amendments). "§n" points at that spec; "v1 §n" at `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md`.
Executors: superpowers:subagent-driven-development. One commit set per task, Conventional Commits, no `Co-Authored-By` trailer, `pnpm check` green before every commit, full e2e green at every checkpoint, CI on three OSes at every push (verify with `gh run list --branch`, never the PR check summary).

**Goal:** Environments as a first-class left-menu view with a Postman-style editor (variables with an *enabled* checkbox, endpoint overrides grouped by project); no permanent right panel; left, bottom and slide-over panels that collapse, resize and remember themselves.
**Architecture:** one additive format change (a `disabled` name list beside every `properties` map; project and workspace manifests → `formatVersion: 2`, globals file → `version: 2`) flows engine → main → IPC → stores; everything else is renderer shell work on `react-resizable-panels`.
**Stack:** unchanged (v1 §3). No new dependency.

## Global constraints (every task inherits)

- Everything in v1 §12, ADR-0003, ADR-0004, ADR-0005, ADR-0006, and the workspaces plan's constraints.
- The only file-format change is the `disabled: string[]` list (§1 Assumption 1). It bumps `FORMAT_VERSION` and `WORKSPACE_FORMAT_VERSION` to 2 and the globals file to `version: 2`, each with a migration that reads a missing list as empty. A version-1 file must load unchanged; a newer version must fail with the existing clear error. Nothing else in any file changes.
- A disabled property is ignored by resolution exactly as if absent: the shorthand falls through to the next scope, the explicit reference is unresolved. Its value stays on disk.
- Renderer-only otherwise: no path ever leaves the renderer; no new channel carries a path; the main editor area never collapses (≥ 30 % width, ≥ 20 % height).
- Keep existing testids: `environment-row`, `environment-editor`, `environment-endpoint`, `env-switcher`, `endpoint-env-badge`, `activity-bar`, `sidebar`, `status-bar`, `status-bar-problems`.
- Every new control is keyboard reachable with an accessible name; handles are `role="separator"`.
- UI copy: *Environments*, *Globals*, *Workspace*, *Variables*, *Endpoints*, *Enabled*; never *collection*; no other tool named anywhere (`pnpm check:banned-terms`).
- Snapshots and docs screenshots are regenerated only after the suite is green, in their own commit, on macOS.
- Ask first: any further format change; any new dependency; any shortcut change beyond `view.toggleDetails` → `view.toggleCode`; CI/release changes.

## Order & rationale

```
W0 format   1 (engine model/schema/migrate) → 2 (engine resolution)
W1 wiring   3 (main + IPC + wire types)                     = the enabled flag reaches the renderer
W2 envs     4 (stores) → 5 (Environments view) → 6 (environment page)   = environments.spec green on the new path
W3 right    7 (details inspector + project tab) → 8 (rail + slide-over, right panel removed, ui-state v4)
W4 panels   9 (handles, collapse, buttons, double-click, persistence, layout.spec)
W5 ship    10 (docs, ADR notes, changelog, screenshots)
```

- The format change goes first and alone, so its migration and round-trip tests are reviewed before any UI depends on the flag.
- The Environments view lands before the right panel is removed, so the properties tabs have their new home before the old one disappears.
- Panel behaviour is last among features because it touches the shell that every other task renders into; the e2e layout spec is its own gate.

## Names later tasks depend on (define once, reuse verbatim)

```ts
// engine — packages/engine/src (T1–T2)
FORMAT_VERSION = 2 · WORKSPACE_FORMAT_VERSION = 2
Project.disabledProperties: readonly string[] · Environment.disabledProperties · Workspace.disabledProperties · WorkspaceEnvironment.disabledProperties   // sorted, deduplicated on save; absent on disk when empty
enabledProperties(map: PropertyMap, disabled: readonly string[]): PropertyMap          // project/properties.ts; the ONLY place the filter lives
migrate(document, file) / migrateWorkspace(document, file): 1 → 2 adds nothing (loader defaults the list); `formatVersion: 1` on disk is rewritten as 2 on the next save
// main — apps/desktop/src/main (T3)
GlobalProperties: file `{ version: 2, properties, disabled }`; get(): { properties, disabled }; setEnabled(name, enabled): Promise<GlobalsState>
ProjectChange + 'set-project-property-enabled' { name, enabled }
WorkspaceChange + 'set-workspace-property-enabled' { name, enabled } · update-workspace-environment.patch.disabled?: string[]
channels.globals.setEnabled { name, enabled } → { properties, disabled } · events.globals.changed carries disabled
wire: ProjectWire.disabledProperties · EnvironmentWire.disabled · WorkspaceWire.disabled · WorkspaceEnvironmentWire.disabled · GlobalsState { properties, disabled }
// renderer (T4+)
SidebarView + 'environments' · command view.showEnvironments · testid activity-environments
EditorTab.kind + 'project' · PersistedTab.kind + 'project'
tab ids: env:<environmentId> · env:globals · env:workspace · project:<projectId>
EnvironmentTarget = { kind: 'environment'; id } | { kind: 'globals' } | { kind: 'workspace' }
testids: environments-view · environment-row[data-kind=globals|workspace|environment][data-active] · environments-add · env-variable-table · env-variable-row · env-variable-enabled · env-variable-name · env-variable-value · env-variable-delete · env-endpoints-table · workspace-env-source · project-tab · project-properties-table · request-details-inspector · rail-code · slide-over · slide-over-close · panel-handle-sidebar · panel-handle-console · panel-handle-slide-over · sidebar-collapse · console-collapse · status-bar-sidebar · status-bar-console
commands: view.showEnvironments · view.toggleCode (Mod+Alt+B) · view.toggleDetails REMOVED
ui-state v4: { sidebar: { visible, view, size, lastSize }, console: { visible, activeTab, size, lastSize }, slideOver: { open, width }, theme, editorLineNumbers, editorLayout, workspaces }   // `details` removed
state/endpoint-override.ts: effectiveEndpointSource(...) moves here from environment-grid.tsx (same signature)
e2e helpers: openEnvironmentsView(page) · openEnvironment(page, name) · setVariable(page, name, value) · toggleVariable(page, name)
```

## Tasks

### W0 — Format

- [ ] **1. `disabled` in the engine formats**
  - `project/model.ts` (`disabledProperties` on `Project`, `Environment`; `FORMAT_VERSION = 2`; factories default `[]`), `project/schema.ts` (`disabled: z.array(z.string()).optional()` on the manifest and environment files; `formatVersion: z.literal(2)`), `project/serialize.ts` (write `disabled` sorted+deduped only when non-empty), `project/load.ts` (default `[]`; exact()), `project/migrate.ts` (accept 1 and 2; 1 needs no rewrite; 3 → too-new). Mirror in `workspace/{model,schema,serialize,load,migrate}.ts` for `Workspace` and `WorkspaceEnvironment` (`WORKSPACE_FORMAT_VERSION = 2`). `workspace/reidentify.ts` keeps the lists. Update every golden/inline snapshot that pins `formatVersion: 1`.
  - Acceptance: round trip keeps `disabled` for all four documents; a v1 manifest (fixture from a 1.0.0 project and workspace, committed under `packages/engine/test/fixtures/format-v1/`) loads with empty lists and is written back at 2 with nothing else changed (diff = the version line); `formatVersion: 3` → too-new; a name listed in `disabled` but absent from `properties` is dropped on save.
  - Verify: `pnpm vitest run packages/engine/test/unit/project packages/engine/test/unit/workspace`
  - Files: packages/engine/src/project/{model,schema,serialize,load,migrate}.ts, packages/engine/src/workspace/{model,schema,serialize,load,migrate,reidentify}.ts, packages/engine/test/unit/{project,workspace}/*.test.ts, packages/engine/test/fixtures/format-v1/**

- [ ] **2. Resolution ignores disabled properties**
  - `project/properties.ts`: `enabledProperties(map, disabled)`; `project/environments.ts` `resolveScopes` and `workspace/environments.ts` `resolveWorkspaceScopes`/`linkedEnvironment` build every scope from enabled properties only (project, project env, workspace, workspace env). `expand` itself is untouched.
  - Acceptance: table tests: disabled in env → shorthand falls through to project, `${#Env#x}` unresolved with code `missing`; disabled in workspace env with an enabled linked-project value → project wins as before; disabled everywhere → unresolved; globals are filtered by the caller (main), documented.
  - Verify: `pnpm vitest run packages/engine/test/unit/project/properties packages/engine/test/unit/project/environments packages/engine/test/unit/workspace/environments`
  - Files: packages/engine/src/project/{properties,environments}.ts, packages/engine/src/workspace/environments.ts, packages/engine/src/index.ts, the three test files

**Checkpoint W0:** engine coverage ≥ 85 %; no desktop file touched.

### W1 — Wiring

- [ ] **3. Main, IPC and wire types carry the flag**
  - `main/global-properties.ts` (file `version: 2` with `disabled`, v1 read as empty, `setEnabled`, `get()` returns `{properties, disabled}`); `ipc/globals.ts` + `channels.globals.setEnabled`; `globals.changed` payload; `project-mutations.ts` `set-project-property-enabled`; `workspace-service.ts` `set-workspace-property-enabled` and `update-workspace-environment.patch.disabled` (whole-list replace, like the maps); `project-host.ts` `scopesFor` passes `enabledProperties(globals.properties, globals.disabled)`; `wire-types.ts` fields per the names block; `toProjectWire`/workspace snapshot fill them.
  - Acceptance: ipc tests for the new channel and change kinds; a real-engine test in `workspace-environments.test.ts`: disable a workspace-env property and the next send's expansion falls through; globals file round trip and v1 read.
  - Verify: `pnpm vitest run apps/desktop/test/globals-ipc apps/desktop/test/global-properties apps/desktop/test/project-mutations apps/desktop/test/workspace-environments apps/desktop/test/ipc-workspace`
  - Files: apps/desktop/src/main/{global-properties.ts,ipc/globals.ts,project-mutations.ts,workspace-service.ts,project-host.ts,project-wire.ts}, apps/desktop/src/shared/{ipc.ts,wire-types.ts}, the tests above, apps/desktop/test/mocks/wirebench-api.ts

### W2 — Environments

- [ ] **4. Stores mirror `disabled`; shared endpoint helper**
  - `state/globals.ts` (`{properties, disabled}`, `setEnabled`), `state/project.ts` (`disabledProperties` on the mirror, `setProjectPropertyEnabled(projectId, name, enabled)`), `state/workspace.ts` (`setWorkspacePropertyEnabled`, `updateEnvironment(id, {properties?, disabled?, endpoints?})` through the existing per-environment queue in `environment-queue.ts`), `state/endpoint-override.ts` absorbs `effectiveEndpointSource` from `environment-grid.tsx` (the grid file itself is deleted in T6).
  - Acceptance: store tests for each action's payload; the queue test still proves two quick edits both land.
  - Verify: `pnpm vitest run --project desktop`
  - Files: apps/desktop/src/renderer/state/{globals,project,workspace,endpoint-override}.ts, apps/desktop/src/renderer/features/environments/environment-queue.ts, apps/desktop/test/renderer/{globals-store,project-store,workspace-store,endpoint-override}.test.ts

- [ ] **5. Environments view in the left menu**
  - `SidebarView` + `'environments'`; `activity-bar.tsx` item under Explorer (`activity-environments`); `sidebar.tsx` mapping; `commands/register-view-commands.ts` `view.showEnvironments`; `features/environments/environments-view.tsx` (§2.1: Globals, Workspace, divider, environments by `order`; check mark on the active one; hover *Set active*; click the mark to deactivate; context menu Open / Set active or Deactivate / Rename inline / Duplicate / Delete via `ConfirmDialog`; Globals and Workspace rows *Open* only; toolbar *Add environment* + collapse chevron); `env-switcher.tsx` *Manage environments…* → `view.showEnvironments` + open the active one. Delete `environments-section.tsx` and its Explorer mount. Persisted `sidebarView` accepts the new value.
  - Acceptance: component tests: list order, active mark and calls, menu items per row kind, add creates and opens; `environments.spec.ts` step "add `uat` via the sidebar" moved to the new view (rest of the spec still on the old editor until T6 — keep it green by keeping `environment-editor.tsx` mounted for the tab this task).
  - Verify: `pnpm vitest run --project desktop`; `pnpm build && pnpm test:e2e -- --grep environments`
  - Files: apps/desktop/src/renderer/state/ui-state.ts, apps/desktop/src/renderer/shell/{activity-bar,sidebar}.tsx, apps/desktop/src/renderer/commands/register-view-commands.ts, apps/desktop/src/renderer/features/environments/{environments-view.tsx,env-switcher.tsx,environment-actions.ts}, apps/desktop/src/renderer/features/explorer/explorer-view.tsx, apps/desktop/test/renderer/environments-view.test.tsx, e2e/specs/environments.spec.ts, e2e/helpers/environments.ts

- [ ] **6. Environment page: variables table + endpoints group**
  - `features/environments/environment-page.tsx` (§2.2; `EnvironmentTarget`; header with editable name and *Active* toggle for environments; scope hint), `variables-table.tsx` (Enabled checkbox first, Variable, Value, delete; always-present add row; inline commit on Enter/Tab, revert on Escape; duplicate/empty name flagged, not saved; disabled rows muted; one save path per target from T4), `endpoints-table.tsx` (rows per interface grouped by project, datalist of declared endpoints, `environment-endpoint` input, `workspace-env-source` label from `state/endpoint-override.ts`; clearing removes the key). Tab ids per the names block; `openEnvironmentTab(target)`; persisted tabs restore `env:globals`/`env:workspace`. Delete `environment-grid.tsx` and `environment-editor.tsx`; the linked project's own environments editor stays where Task 12 of the workspaces plan put it (project row context menu).
  - Acceptance: component tests for every behaviour above incl. the exact patch per target; `environments.spec.ts` rewritten to the page (same assertions: override → second server only; `${#Env#missing}` in Problems) plus: untick a variable → the next send falls through to the workspace value, tick it back → the env value again.
  - Verify: `pnpm vitest run --project desktop`; `pnpm build && pnpm test:e2e -- --grep environments`
  - Files: apps/desktop/src/renderer/features/environments/{environment-page.tsx,variables-table.tsx,endpoints-table.tsx,environment-actions.ts}, apps/desktop/src/renderer/shell/editor-area.tsx, apps/desktop/src/renderer/state/{ui-state.ts,workspace-tabs.ts}, apps/desktop/test/renderer/{environment-page,variables-table,endpoints-table}.test.tsx, e2e/specs/environments.spec.ts, e2e/helpers/environments.ts

**Checkpoint W2:** SC1–SC3 of §11; full e2e green.

### W3 — Right panel

- [ ] **7. Details inspector and project tab**
  - `features/request-editor/inspectors/details-inspector.tsx` (§3.2 row 1) registered in the request pane's `InspectorStrip` items as *Details* (`request-details-inspector`); `features/project/project-tab.tsx` (`project-tab`: name, folder + *Reveal* via `workspace.revealProject`, source, `ProjectSettings` fields through `updateProjectSettings`, `project-properties-table` = the variables table from T6 bound to project properties with `set-project-property(-enabled)`/`remove-project-property`); `editors.ts` kind `'project'`, tab id `project:<id>`, title = project name (updates on rename); explorer: single click on a project row opens it pinned (§12 Q4), *Settings…* does the same; `PersistedTab` + `'project'`.
  - Acceptance: component tests for the inspector content (endpoint + source), the project tab (fields, reveal call id-only, properties edits), explorer click → tab; existing explorer tests updated.
  - Verify: `pnpm vitest run --project desktop`
  - Files: apps/desktop/src/renderer/features/request-editor/inspectors/{details-inspector.tsx,inspector-strip.tsx}, apps/desktop/src/renderer/features/request-editor/request-editor.tsx, apps/desktop/src/renderer/features/project/project-tab.tsx, apps/desktop/src/renderer/features/explorer/{explorer-view.tsx,project-actions.ts,context-menu.tsx}, apps/desktop/src/renderer/state/{editors.ts,ui-state.ts,workspace-tabs.ts}, apps/desktop/src/renderer/shell/editor-area.tsx, apps/desktop/test/renderer/{details-inspector,project-tab,explorer-view}.test.tsx

- [ ] **8. Right rail, slide-over, right panel removed, ui-state v4**
  - `shell/right-rail.tsx` (40 px, `rail-code`), `shell/slide-over.tsx` (§3.3: overlay anchored right, 420 px default, left handle resize, close icon, Escape, toggle by the rail icon; hosts `CodePanel` moved to `shell/code-panel.tsx`), command `view.toggleCode` `Mod+Alt+B`; delete `shell/details-panel.tsx`, `features/details/`, `view.toggleDetails`, the `details` ui-state slice; `UI_STORAGE_VERSION = 4` with the names-block shape (`lastSize` fields land here, used by T9; `slideOver: {open, width}`); `app-shell.tsx` drops the details pane and mounts the rail + slide-over; `WorkspaceProperties`/`PropertyTable` usages that only the panel had are deleted or moved.
  - Acceptance: component tests: rail toggles, Escape closes, width persists, v3 blob discarded, v4 round trip; `keyboard.spec.ts` updated for `Mod+Alt+B`; a11y shell baselines regenerated in a dedicated commit (the right panel is gone from every shot).
  - Verify: `pnpm vitest run --project desktop`; `pnpm build && pnpm test:e2e`
  - Files: apps/desktop/src/renderer/shell/{right-rail.tsx,slide-over.tsx,code-panel.tsx,app-shell.tsx,editor-area.tsx,status-bar.tsx}, apps/desktop/src/renderer/state/{ui-state.ts,ui.ts}, apps/desktop/src/renderer/commands/register-view-commands.ts, apps/desktop/src/shared/commands.ts, apps/desktop/test/renderer/{right-rail,slide-over,ui-state-v4}.test.tsx, e2e/specs/{keyboard,a11y}.spec.ts, e2e/specs/__screenshots__/**

**Checkpoint W3:** SC4 of §11; full e2e green.

### W4 — Panels

- [ ] **9. Handles, collapse, buttons, double-click, persistence**
  - `shell/panel-handle.tsx` (§4: 4 px strip, 8 px hit area, hover/drag tint tokens added to `styles/tokens.css` and passing `pnpm contrast:check`, `role="separator"`, `aria-orientation`, `aria-valuenow`, arrow keys 2 %); `app-shell.tsx`: sidebar and console panels `collapsible` with `collapsedSize={0}` and their minimums, `onCollapse`/`onExpand` → `visible`, `lastSize` recorded before collapse, imperative `collapse()`/`expand()` refs; double-click on a handle toggles the adjacent panel to `lastSize`; `sidebar-collapse` chevron in the sidebar header, `console-collapse` in the console header; status bar left corner `status-bar-sidebar` and `status-bar-console` (badge reuses the problems count); the activity bar's icon reopens a collapsed sidebar; the slide-over's handle uses the same component; `Mod+B`/`Mod+J` unchanged.
  - Acceptance: component tests for the handle's a11y attributes and keyboard resize; e2e `layout.spec.ts` (§9): drag past minimum collapses and the activity bar stays; double-click restores the previous size (assert the sidebar width before/after); buttons and shortcuts toggle; slide-over opens without shifting the editor (assert the editor's bounding box); relaunch restores collapsed states and sizes.
  - Verify: `pnpm vitest run --project desktop`; `pnpm build && pnpm test:e2e -- --grep "layout|keyboard"`; then the full suite
  - Files: apps/desktop/src/renderer/shell/{panel-handle.tsx,app-shell.tsx,sidebar.tsx,console-panel.tsx,status-bar.tsx,activity-bar.tsx,slide-over.tsx}, apps/desktop/src/renderer/state/{ui-state.ts,ui.ts}, apps/desktop/src/renderer/styles/tokens.css, apps/desktop/test/renderer/{panel-handle,app-shell-panels}.test.tsx, e2e/specs/layout.spec.ts, e2e/helpers/layout.ts

**Checkpoint W4:** SC5 of §11.

### W5 — Ship

- [ ] **10. Docs, ADR notes, changelog, screenshots**
  - README (shortcuts table: `view.showEnvironments`, `view.toggleCode`; the Environments section; screenshots), `docs/architecture/overview.md` (shell: rail, slide-over, panel state; the `disabled` list in the format section), `CHANGELOG.md` Unreleased: *Added* (Environments view, enabled checkbox, project tab, code slide-over, collapsible panels), *Changed* (project and workspace format version 2, globals file version 2 — a 1.0.0 build cannot open files written by this version), *Removed* (right panel); ADR-0003 and ADR-0006 gain a dated note for version 2 and the `disabled` list; `docs/success-criteria.md` row for §11 citing real test paths; `docs/roadmap.md` notes the current-value split as a candidate. Regenerate `docs/images` and the a11y baselines in a dedicated commit after the full suite is green.
  - Acceptance: `pnpm check` (doc-paths, banned terms, contrast) green; full e2e green; CI green on three OSes.
  - Verify: `pnpm check && pnpm build && pnpm test:e2e`
  - Files: README.md, docs/architecture/overview.md, CHANGELOG.md, docs/adr/{0003-project-folder-format.md,0006-workspaces-in-app-data.md}, docs/success-criteria.md, docs/roadmap.md, docs/images/*.png, e2e/specs/__screenshots__/**

**Checkpoint W5 (final):** all §11 criteria evidenced; final whole-branch review; CI green.

## Risks

| Risk | Mitigation |
|---|---|
| The format bump strands 1.0.0 users who open a newer file with the old build | Documented in the changelog and ADR notes; v1 files keep loading; the bump is one release ahead of any workspace file a user could have |
| Whole-list replace of `disabled` races like the maps did | Same per-environment queue; the T4 queue test covers it |
| `react-resizable-panels` collapse semantics differ from the persisted `visible` flag | T9 derives `visible` from `onCollapse`/`onExpand` only; e2e relaunch test proves the round trip |
| Removing the right panel breaks a spec that clicked its tabs | `grep -rn "details-panel\|Global properties" e2e` in T8; each moved to the Environments view or the inspector |
| Snapshot churn across T5, T6, T8, T9 | Baselines regenerated only at T8 and T9, each in its own commit after a green suite |

## Unresolved questions

None. Defaults per §12: no current-value split; code rail only; `Mod+Alt+B` to the slide-over.
