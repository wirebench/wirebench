# Spec: Environments view, right panel removal, collapsible panels

- Status: approved 2026-09-12 with the §12 defaults and the two amendments; implemented by `docs/plans/2026-09-12-wirebench-layout-and-environments-plan.md`
- Date: 2026-09-12
- Builds on: `docs/specs/2026-09-11-wirebench-workspaces-design.md` (workspace environments, `${#Workspace#…}` scope), the v1 design (§5 IDE shell, §10 style, §12 boundaries), ADR-0006.
- Decisions taken with the owner on 2026-09-12: Environments becomes its own left-menu view with one variables table plus an endpoints group per environment; the right panel is removed and its content relocated; left, right and bottom panels get visible drag handles, collapse by dragging past the minimum, collapse and expand buttons, and double-click to collapse or restore. Amendments the same day: every variable gets a per-row *enabled* checkbox now (a file-format change, approved here), and selecting a project row opens its tab immediately.

## Assumptions I'm making

1. **One additive file-format change, approved by the owner.** Every property scope gains a per-variable *enabled* flag. On disk it is a sibling list `disabled: [name, …]` next to each `properties` map (workspace environments, `workspace.yaml`, `global-properties.yaml`, and the project's `wirebench.yaml`), so the maps stay `name → value`. Under ADR-0003's rule an additive field bumps the format: the workspace manifest and the project manifest go to `formatVersion: 2`, the globals file to `version: 2`, each with a migration that treats a missing list as "all enabled". A 1.0.0 build refuses a version-2 file with its existing clear error. Endpoint overrides stay `"<projectSlug>/<interfaceSlug>" → url` with no flag. Postman's separate *current value* is still out of scope — see Open questions.
2. **"Left menu like file" means an activity-bar view**, the same rank as Explorer, Search, History, WS-Security, Settings — not a section inside Explorer, which is what exists today.
3. **Globals and Workspace properties are environment-shaped** for the user: they appear at the top of the Environments list, as Postman shows *Globals*, and open the same variables table. Their storage is unchanged (`global-properties.yaml` in app data; `workspace.yaml`).
4. **The right panel's *Details* tab has three audiences** today: a request (interface, operation, SOAPAction, endpoint), an interface or endpoint selected in the explorer, and a project. Each moves to the place that already owns that thing: a *Details* inspector in the request editor; the interface tab; a new project tab.
5. **The Code panel keeps its content** (cURL for POSIX and PowerShell, preview, copy) and changes only where it lives: a Postman-style thin icon rail on the right edge that opens a slide-over on demand.
6. **The activity bar never collapses.** Collapsing the left panel hides the sidebar body only; clicking any activity icon reopens it, as in Postman and VS Code.
7. **`react-resizable-panels`** (already a dependency) provides collapsible panels, minimum sizes and an imperative collapse/expand API; no new dependency.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Three changes to the IDE shell:

1. **Environments as a first-class view.** A left-menu entry lists *Globals*, *Workspace* and every workspace environment, marks the active one, and opens a Postman-style editor page: a variables table, and for a real environment an endpoints group below it.
2. **No permanent right panel.** Its four tabs move: *Details* into the request editor and the interface and project tabs; *Workspace properties* and *Global properties* into the Environments view; *Code* behind a right-edge icon rail that opens a slide-over.
3. **Panels that behave like Postman.** The left sidebar, the bottom console and the right slide-over have visible drag handles with hover highlight, collapse when dragged past their minimum, have one-click collapse and expand controls, and toggle on a double-click of the handle. Sizes and collapsed states survive a restart.

**Why.** The current environments editor is a grid tucked under Explorer; the right panel holds unrelated things and steals width from the editors; the splitters are invisible and offer no way to collapse a panel except a keyboard shortcut.

**Who.** Every user of the IDE; environments matter most to people switching between dev, test and prod targets.

**User stories.**
- I click *Environments* in the left menu and see Globals, Workspace, then my environments with the active one marked; I set another active with one click.
- I open `dev` and get a table of variables I can edit inline, add to, delete from, and switch off with a checkbox without deleting them, plus a list of every interface with its `dev` endpoint override.
- I edit Globals and Workspace properties the same way, from the same list.
- The editors take the full width; when I want the cURL I click the code icon on the right edge and a panel slides over; I close it and it is gone.
- I drag the sidebar shut and it snaps closed; I double-click the handle and it comes back at the size it had; there is a button for each panel and the keyboard shortcuts still work.
- I quit and relaunch: the panels are where I left them.

**Non-goals.** Postman's *initial* versus *current* values (Open question 1); environment import and export; environment-level secrets beyond today's secretRef fields; multi-window; touch gestures.

---

## 2. Environments view

### 2.1 Left-menu entry
- New `SidebarView` `'environments'`, an activity-bar item labelled *Environments* placed directly under *Explorer* (Postman order), command `view.showEnvironments`, testid `activity-environments`.
- The sidebar body (`features/environments/environments-view.tsx`, testid `environments-view`) lists, in order: **Globals**, **Workspace**, a divider, then every workspace environment in `order`. Rows keep testid `environment-row` with `data-active`; Globals and Workspace rows carry `data-kind="globals"` / `"workspace"`.
- The active environment shows a check mark; hovering another row shows *Set active*; clicking the mark on the active row deactivates (*No environment*). The status-bar switcher stays and is kept in sync.
- Row context menu: *Open*, *Set active* / *Deactivate*, *Rename*, *Duplicate*, *Delete* (confirmation through the shared `ConfirmDialog`). Globals and Workspace rows offer *Open* only.
- Toolbar: *Add environment* (creates `Environment N`, opens it, focuses the name), *Collapse sidebar*.
- The `EnvironmentsSection` inside Explorer is removed. Explorer keeps projects only.

### 2.2 Editor page (Postman style)
One tab kind `environment` (existing) now covers three targets: an environment id, `globals`, `workspace`. Component `features/environments/environment-page.tsx` (testid `environment-editor`, kept):
- **Header**: editable name (environments only), *Active* toggle (environments only), and the effective scope hint (`${#Env#name}` / `${#Workspace#name}` / `${#Global#name}`).
- **Variables table** (`env-variable-table`): columns *Enabled* (checkbox, first, as in Postman), *Variable*, *Value*, row actions. Every row is editable inline; Enter or Tab commits, Escape reverts; the last row is always an empty *Add variable* row; a duplicate or empty name is flagged inline and not saved; delete has no confirmation (undo is a retype; the value is visible). A disabled row is rendered muted, keeps its value, and is ignored by property resolution exactly as if it did not exist, so `${name}` falls through to the next scope and `${#Env#name}` reports unresolved. Rows `env-variable-row`, inputs `env-variable-enabled` / `env-variable-name` / `env-variable-value`. Saving goes through the per-target channels: `update-workspace-environment` (whole `properties` map and whole `disabled` list, serialised by the existing per-environment queue), `set-workspace-property` / `remove-workspace-property` / `set-workspace-property-enabled`, `globals.set` / `globals.remove` / `globals.setEnabled`; the project tab's properties table uses `set-project-property` / `remove-project-property` / `set-project-property-enabled`.
- **Endpoints group** (environments only, `env-endpoints-table`): one row per interface of every open project, grouped by project with the project name as a group header, columns *Interface*, *Endpoint override* (input with the interface's declared endpoints as a datalist, testid `environment-endpoint` kept), *Effective* (the existing source label: workspace / project / interface). Clearing a cell removes the override. Uses the existing `update-workspace-environment` path and queue.
- A linked project's own environments are not shown here; they stay reachable from the project row's context menu as today.

### 2.3 Removed
`environments-section.tsx`, `environment-grid.tsx` (its `effectiveEndpointSource` helper moves to `state/endpoint-override.ts`, which already holds the shared precedence), the Explorer's environments toolbar entry.

---

## 3. Right panel

### 3.1 Removal
`shell/details-panel.tsx`, the `details` slice of the UI state, `view.toggleDetails` and the *Details* keyboard shortcut are removed. The editors area extends to the right edge minus the icon rail.

### 3.2 Where the content goes
| Today | Tomorrow |
|---|---|
| Details for a request | A *Details* inspector tab in the request editor's inspector strip (interface, operation, SOAPAction, resolved endpoint with its source, project), testid `request-details-inspector`. |
| Details for an interface or endpoint | The interface tab (already exists): selecting an interface row shows the tab on double-click or *Show Interface Viewer* as today; endpoint rows open the interface tab scrolled to its endpoints. |
| Details for a project | A new project tab (`features/project/project-tab.tsx`, testid `project-tab`): name, folder (read-only, *Reveal* button), source (internal or linked), settings (the existing `ProjectSettings` fields), and the project's properties table with the same *Enabled* column. Opened, as a normal pinned tab, by a single click on the project row and by *Settings…* on its context menu. |
| Workspace properties | The *Workspace* entry of the Environments view (§2). |
| Global properties | The *Globals* entry of the Environments view (§2). |
| Code (cURL, PowerShell, preview, copy) | The right icon rail (§3.3). |

### 3.3 Right icon rail and slide-over
- `shell/right-rail.tsx`: a 40 px vertical strip on the right edge with one icon for now, *Code* (`</>`), testid `rail-code`; command `view.toggleCode` (`Mod+Alt+B`, reusing the freed shortcut). The rail is part of the shell layout, always visible when a workspace is open.
- Clicking opens `shell/slide-over.tsx`: an overlay panel anchored to the right, 420 px default, resizable by its left handle, closable by its icon, by Escape, or by clicking the rail icon again; it does not shift the editors. Its width and last-open state are remembered.
- Content: the existing `CodePanel` unchanged (shell choice remembered as today).

---

## 4. Panels

Applies to the left sidebar, the bottom console and the slide-over. The activity bar and the status bar never collapse.

- **Handles** (`shell/panel-handle.tsx`): a 4 px strip with an 8 px hit area, `cursor: col-resize` / `row-resize`, tinted on hover and while dragging, `role="separator"` with `aria-orientation`, `aria-valuenow` in percent, keyboard arrows resize in 2 % steps.
- **Collapse by drag**: each panel is `collapsible` with `minSize` (sidebar 12 %, console 10 %) and `collapsedSize` 0; dragging past the minimum snaps it shut and records the last size; dragging the handle back out reopens it.
- **Buttons**: a chevron in each panel's header (`sidebar-collapse`, `console-collapse`) and, in the status bar's left corner, two Postman-style toggles: *Sidebar* (`status-bar-sidebar`) and *Console* (`status-bar-console`, showing the problem count badge that already exists). The activity bar's active icon reopens a collapsed sidebar.
- **Double-click** on a handle collapses the adjacent panel or restores it to its last size.
- **Keyboard**: `view.toggleSidebar` (`Mod+B`) and `view.toggleConsole` (`Mod+J`) unchanged; `view.toggleCode` (`Mod+Alt+B`) new.
- **Persistence**: `UI_STORAGE_VERSION` 4; per panel `{ visible, size, lastSize }`; the slide-over `{ open, width }`; the `details` slice removed. A version-3 blob is discarded to defaults, as previous bumps did.
- **Minimums** protect the editors: the main area never drops below 30 % width or 20 % height.

---

## 5. Architecture and files

Mostly renderer, plus the *enabled* flag end to end. New or changed:

```
packages/engine/src/project/{model.ts, schema.ts, serialize.ts, load.ts, migrate.ts, properties.ts, environments.ts}   ← `disabledProperties: readonly string[]` on Project and Environment; FORMAT_VERSION 2 + migration; resolveScopes strips disabled names
packages/engine/src/workspace/{model.ts, schema.ts, serialize.ts, load.ts, migrate.ts, environments.ts}                ← same for Workspace and WorkspaceEnvironment; WORKSPACE_FORMAT_VERSION 2
apps/desktop/src/main/{global-properties.ts, project-host.ts, workspace-service.ts, project-mutations.ts}              ← globals file version 2 with `disabled`; new change kinds applied; resolution passes only enabled names
apps/desktop/src/shared/{ipc.ts, wire-types.ts}                                                                       ← `disabled` on the property-bearing wire types; change kinds set-workspace-property-enabled, set-project-property-enabled, update-workspace-environment.patch.disabled; channel globals.setEnabled
apps/desktop/src/renderer/
  features/environments/{environments-view.tsx, environment-page.tsx, variables-table.tsx, endpoints-table.tsx, environment-actions.ts, environment-queue.ts, env-switcher.tsx}
  features/environments/{environments-section.tsx, environment-grid.tsx, environment-editor.tsx}   ← deleted
  features/project/project-tab.tsx
  features/request-editor/inspectors/details-inspector.tsx (+ inspector-strip.tsx entry)
  shell/{right-rail.tsx, slide-over.tsx, panel-handle.tsx, app-shell.tsx, sidebar.tsx, activity-bar.tsx, status-bar.tsx, editor-area.tsx}
  shell/details-panel.tsx                                    ← deleted; features/details/code-panel.tsx moves under shell/ or stays, unchanged
  state/{ui-state.ts, ui.ts, endpoint-override.ts}
  commands/register-view-commands.ts (view.showEnvironments, view.toggleCode; view.toggleDetails removed)
apps/desktop/test/renderer/{environments-view, environment-page, variables-table, endpoints-table, project-tab, details-inspector, right-rail, slide-over, panel-handle, ui-state-v4}.test.tsx
e2e/specs/{environments.spec.ts (rewritten to the view), layout.spec.ts (new), a11y.spec.ts (baselines), keyboard.spec.ts (panel shortcuts)}
docs/{README.md shortcuts + screenshots, architecture/overview.md shell section, CHANGELOG.md}
```

---

## 6. Tech stack

Unchanged (the format bump needs no library): React 19, zustand, Radix, `react-resizable-panels`, Tailwind 4, lucide icons, vitest + Testing Library, Playwright. No new dependency.

## 7. Commands

Unchanged from the v1 design §8: `pnpm dev`, `pnpm check`, `pnpm test`, `pnpm build && pnpm test:e2e`, `pnpm test:e2e -- --grep "environments|layout"`, `pnpm lint:fix`. Snapshots: `pnpm test:e2e -- --grep "looks right" --update-snapshots` on macOS after the suite is green.

## 8. Code style

v1 §10 applies. One snippet for the collapsible panel pattern:

```tsx
// apps/desktop/src/renderer/shell/app-shell.tsx (excerpt)
<Panel
  id="sidebar-panel"
  ref={sidebarRef}
  collapsible
  collapsedSize={0}
  minSize="12%"
  defaultSize={`${String(sidebar.visible ? sidebar.size : 0)}%`}
  onResize={(size) => sidebar.visible && setSidebarSize(percent(size))}
  onCollapse={() => setSidebarVisible(false)}
  onExpand={() => setSidebarVisible(true)}
>
  <Sidebar onCollapse={() => sidebarRef.current?.collapse()} />
</Panel>
<PanelHandle orientation="vertical" onDoubleClick={() => togglePanel(sidebarRef, sidebar.lastSize)} />
```

Conventions specific to this feature: UI copy says *Environments*, *Globals*, *Workspace*, *Variables*, *Endpoints*; never *collection*; the active environment is a check mark, not a radio; every new control is keyboard reachable and labelled.

## 9. Testing strategy

| Level | Cases |
|---|---|
| Unit (engine + main) | Load/save round-trip of `disabled` for project, workspace, environment and globals files; a version-1 file loads with an empty list and is written back at version 2; a disabled name is absent from every scope `resolveScopes`/`resolveWorkspaceScopes` build, so the shorthand falls through and the explicit reference is unresolved; `reidentifyProject` keeps the list; the change kinds apply and persist |
| Component | Environments list order (Globals, Workspace, divider, environments by `order`), active mark and set/deactivate calls, context-menu items per row kind; variables table: inline edit commit/revert, add-row, duplicate and empty name flagged, delete, the exact patch sent for each of the three targets; endpoints table: rows per project › interface, override edit sends the whole map with one key changed, clearing removes the key, effective label for the three sources; project tab renders settings and properties and reveal calls the id-only channel; details inspector shows the resolved endpoint and source; right rail toggles the slide-over and Escape closes it; UI state v4 round-trip and v3 discard |
| E2E `environments.spec.ts` | Rewritten to the view: add `uat`, override one interface's endpoint to a second server, set active from the list, send goes to the second server only, `${#Env#missing}` in Problems — same assertions as today, new path |
| E2E `layout.spec.ts` (new) | Drag the sidebar handle past its minimum → collapsed and the activity bar still visible; double-click the handle → restored to the previous size; status-bar buttons toggle sidebar and console; `Mod+B`/`Mod+J`/`Mod+Alt+B`; code slide-over opens over the editor without shifting it, closes on Escape; relaunch restores collapsed states and sizes |
| E2E existing | Full suite green; `keyboard.spec.ts` gains the panel shortcuts; a11y snapshots regenerated on macOS in a dedicated commit; docs screenshots regenerated |
| Static | `pnpm check` incl. contrast (new tinted handle colours are tokens), banned terms, doc paths |

## 10. Boundaries

**Always** — v1 §12 and ADR-0005; renderer-only change, no new channels; every new control keyboard reachable with an accessible name; keep existing testids (`environment-row`, `environment-editor`, `environment-endpoint`, `env-switcher`, `endpoint-env-badge`); regenerate snapshots only after the suite is green, in their own commit.
**Ask first** — any file-format change beyond the approved `disabled` list (a *current value* would need another); any new dependency; removing a keyboard shortcut other than the freed `Mod+Alt+B`; changing the activity-bar order beyond inserting *Environments* under *Explorer*.
**Never** — lose an edit because two cells were saved out of order (the per-environment queue stays); let the main editor area collapse; store anything from the slide-over in project or workspace files; name other tools in UI copy.

## 11. Success criteria

1. The activity bar shows *Environments* under *Explorer*; its list shows Globals, Workspace and the environments, marks the active one, and one click switches (e2e).
2. Opening an environment shows the variables table and the endpoints group; an edited variable and an edited endpoint override both round-trip to disk and are used by the next send (e2e: the existing second-server assertion); unticking a variable's checkbox makes the next send fall through to the lower scope, and the value survives on disk (e2e + unit).
3. Globals and Workspace properties are editable from the same view and expand in a request (component + e2e).
4. No right panel exists; the request editor has a *Details* inspector, the project row opens a project tab, and the code slide-over shows the cURL over the editor and closes on Escape (e2e).
5. Sidebar and console collapse by drag, by button and by double-click; the activity bar stays; sizes and collapsed states survive a relaunch (e2e `layout.spec.ts`).
6. All previously green e2e specs green on three OSes; `pnpm check` green; a11y snapshots updated; README shortcuts and screenshots current.
7. A workspace and a project written by the 1.0.0 build open unchanged and are rewritten at the new format versions; ADR-0003 and ADR-0006 record the bump.

## 12. Open questions (resolved 2026-09-12: the bold text in each line is the decision)

1. Postman's *Initial value* / *Current value* split: **not now** — it needs a session-only value store in main and a further format decision; a later spec if wanted.
2. Per-variable *enabled* checkbox: **now** (owner's decision, 2026-09-12) — stored as a `disabled` name list, formats bumped as in Assumption 1.
3. The freed `Mod+Alt+B` goes to the code slide-over: **yes**.
4. Selecting a project row: **opens the project tab immediately as a normal pinned tab** (owner's decision, 2026-09-12); *Settings…* on the context menu does the same.
5. Keep the *Code* rail icon only, or also a *Details* rail icon that shows the current selection: **Code only**; the request's Details inspector covers the rest.
