# Spec: Wirebench workspaces

- Status: approved 2026-09-11 with the §16 defaults; implemented by `docs/plans/2026-09-11-wirebench-workspaces-plan.md`
- Date: 2026-09-11
- Builds on: `docs/specs/2026-09-09-wirebench-v1-explore-and-send-design.md` (the v1 design; its §3 stack, §8 commands, §10 style, §12 boundaries all still bind), ADR-0003 (project folder format), ADR-0005 (renderer path safety)
- Decisions taken with the owner on 2026-09-11: workspace-level environments with one active environment; projects live inside the workspace by default, external folders can be linked; every project in a workspace is loaded, tabs span projects; **no folder picking in the normal flow** — workspaces are managed in app data, the user creates one or selects an existing one.

## Assumptions I'm making

1. **App data is the home.** A workspace is a folder under Electron's `userData` that the user never has to see. "Open folder…" and "New project…" (folder picker) disappear from the Welcome screen and the menu.
2. **"External allowed" means linking, not opening.** The one remaining folder dialog is *Link existing project folder…* (and *Export project…*), for teams that keep a project in git. It is secondary UI, not the default path.
3. **A project keeps its format.** `wirebench.yaml` stays at `formatVersion: 1`; a project inside a workspace is byte-for-byte a project ADR-0003 already describes. Only the workspace adds files.
4. **Environments move up.** New environments are workspace environments. A project's own environments remain honoured only for linked (git) projects, matched by name.
5. **Entity ids stay globally unique ULIDs**, so every IPC channel that already takes a request/interface id keeps its shape; only the project-lifecycle channels change.
6. **No release has shipped** (no `v1.0.0` tag), so nothing needs to migrate `recent-projects.json`; it becomes an import suggestion list and nothing more.
7. **One window, one workspace.** Multi-window stays out of scope.

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Add a *workspace* layer above projects. A workspace groups any number of projects (a project is the unit that holds interfaces, operations and requests — the "collection" of this tool), owns the environments and a shared property scope, and is what the user opens, switches between and lives in. The mental model is the workspace/collection split Postman users know, applied to SOAP projects.

**Why.** Today the app opens one project folder at a time. Teams exercise several services against the same dev/test/prod targets and want them side by side, with one environment switch that applies to all of them, and without managing folders on disk.

**Who.** The v1 user (integration engineer, QA, support) who has more than one WSDL in play.

**User stories.**
- On first launch I see my workspaces (none yet) and create one by typing a name. Nothing asks me for a folder.
- In a workspace I create projects by name, or import a WSDL and get a project named after the service.
- The explorer shows every project; I can have requests from two projects open in tabs at once.
- I define `dev`, `test`, `prod` once for the workspace, pick one in the status bar, and every send in every project uses it.
- I switch workspaces from the title bar; the app reopens the last one on launch.
- I can link a project folder that lives in a git repository, and export an internal project to a folder when I want to share it.
- Removing a project never silently destroys files: linked projects are unlinked, internal ones go to the OS trash after a confirmation.

**Non-goals.** Multi-window; syncing or sharing workspaces over a network; workspace-level auth profiles or keystores (they stay per project); moving history or secrets into the workspace folder; renaming the concepts ("collection" is never used in UI or docs).

---

## 2. Concept model

| Concept | Wirebench | Lives in | Holds |
|---|---|---|---|
| Workspace | new | `<userData>/workspaces/<workspaceId>/` | name, projects list, environments, workspace properties, active environment |
| Project | existing (unchanged format) | `…/projects/<projectSlug>/` or a linked external folder | interfaces, operations, requests, project properties, WSS configs, keystores, (project environments: linked projects only) |
| Environment | moves up | workspace `environments/<slug>.yaml` | properties, endpoint overrides keyed `<projectSlug>/<interfaceSlug>` |
| Global properties | existing | `<userData>/global-properties.yaml` | user-wide `${#Global#…}` |
| History | existing | `<userData>/history/<projectId>.jsonl` | per project, unchanged |
| Secrets | existing | `<userData>/secrets.json` | unchanged |

Property scope chain for the shorthand `${name}`: **Env → Project → Workspace → Global**. Explicit scopes gain `${#Workspace#name}`. `${#System#…}` stays explicit-only.

---

## 3. Behaviour

### 3.1 Lifecycle
- **Launch.** Open the last-opened workspace. If none exists or it is missing, show the **Workspace picker** (replaces the Welcome screen): list of workspaces (name, project count, last opened), *Create workspace* (name field, Enter creates and opens), *Import project folder…* (see 3.3).
- **Switch.** Title bar shows `wirebench · <Workspace name> ▾`; the dropdown lists workspaces by last opened, then *Create workspace…*, *Manage workspaces…*. Switching autosaves every project, closes the workspace, opens the other. Open tabs, sidebar view and layout are remembered per workspace (`ui-state` keyed by workspace id).
- **Manage workspaces** dialog: rename, delete. Delete asks (`Delete "<name>" and its N internal projects? Linked projects are not touched.`), then moves the workspace folder to the OS trash. History files are kept.
- **Command palette / menu**: `Workspace: Create…`, `Workspace: Switch…`, `Workspace: Manage…`, `Workspace: New Project…`, `Workspace: Link Existing Project Folder…`, `Workspace: Export Project…`, `Workspace: Remove Project`, `Workspace: Set Active Environment…`. Existing `Project: Open…/New…/Close/Recent` commands are removed.

### 3.2 Projects in a workspace
- **New project…** asks for a name only; the folder is `projects/<uniqueSlug(name)>/` with a fresh ULID id. No project environments are created.
- **Import WSDL…** gains an *Into project* selector: existing projects, or *New project "<service name>"* (default when the workspace is empty or nothing is selected). Import into a new project = create project + add interface in one step.
- **Explorer**: one root node per project (name; link badge with the path as tooltip for linked projects; hydration progress; error state for a missing linked folder with *Locate…* / *Remove*). Under it, the existing interface → operation → request tree. Project context menu: Import WSDL…, New Request… (existing, per operation), Rename, Settings…, Reveal in Finder/Explorer, Export project…, Remove from workspace.
- **Remove from workspace**: linked → unlink, files untouched. Internal → confirmation, then the project folder goes to the OS trash. There is no permanent delete anywhere.
- **Link existing project folder…** opens the native folder picker (a main-process `DialogPicks` read pick). The folder must contain a readable `wirebench.yaml`; a project whose id is already in the workspace is refused with `already-in-workspace`, and the dialog offers *Import as copy* instead. Linked projects keep their own autosave and change watcher exactly as today.
- **Import project folder…** copies a folder into `projects/` and re-identifies it (new ULIDs for project, interfaces, requests, environments, WSS configs; secretRefs untouched), so a copy can coexist with its source.
- **Export project…** writes a copy of an internal project to a folder chosen with the native save dialog (write pick). Ids are kept.
- Two projects may have the same name; slugs are made unique with the existing `uniqueSlug`.

### 3.3 Environments and properties
- Workspace environments: name, order, properties, endpoint overrides keyed `<projectSlug>/<interfaceSlug>`. The **Environments view** edits them in one grid: rows = every interface of every project, columns = environments. Properties are edited per environment below the grid.
- **One active environment per workspace**, shown and switched in the status bar (`● dev ▾` → environments, *No environment*, *Manage environments…*).
- **Name linking for linked projects.** When the workspace's active environment has slug `dev`, a linked project that has an environment with slug `dev` treats it as active too. Precedence on the same key: project environment value **wins** over the workspace environment value (nearer scope wins, consistent with the shorthand chain). Same rule for endpoints: request endpointRef ← project env endpoint ← workspace env endpoint ← interface default endpoint, first defined from the left… i.e. the existing resolution with the workspace env inserted after the project env.
- Internal projects have no project-level environments and do not show the project environments editor. A linked project shows its own environments editor as today, marked *project environments (linked project)*.
- `${#Workspace#name}` resolves from the workspace's `properties`. Unresolved references keep surfacing in Problems.
- The project manifest's `activeEnvironmentId` is not read while the project is in a workspace and is not written by the workspace flow; a linked project's file keeps whatever it had.

### 3.4 Everything else
- **Request ids, interface ids, keystore and WSS ids are ULIDs and globally unique**, so tabs, the details panel, send, validate, WS-I, history, attachments and secrets keep addressing entities by id. Main keeps an `entityId → projectId` index for the open workspace.
- **Search / Quick open** span all projects; results are prefixed with the project name.
- **Problems** entries carry `projectId` and are labelled `<project> › <interface> › …`.
- **History** view lists the workspace's projects merged, newest first, with a project filter; storage is unchanged (one jsonl per project, cap 1000 each).
- **Details panel breadcrumb**: `project › interface › operation › request`.
- Preferences, proxy, TLS, keystores, WSS configs: unchanged (keystores/WSS stay per project).

---

## 4. Data model and storage

```
<userData>/
  workspaces/
    01J8…KX/                         ← folder name = workspace id (ULID); never the display name
      workspace.yaml                 ← manifest (below)
      environments/
        dev.yaml                     ← one file per environment
      projects/
        countries/                   ← a regular project folder, ADR-0003, formatVersion 1
        payments/
  workspace-state.json               ← { version: 1, lastOpenedWorkspaceId }
  global-properties.yaml, history/, secrets.json, preferences.yaml   ← unchanged
```

`workspace.yaml` (`formatVersion: 1`, stable key order, atomic writes):

```yaml
formatVersion: 1
id: 01J8K3Q7Z2M5N9RVTX4W6Y8ABC
name: Payments team
description: ''
createdAt: 2026-09-11T10:00:00.000Z
properties:
  region: eu-west-1
activeEnvironmentId: 01J8K3R…
projects:
  - id: 01J8K3S…                    # must equal the project's wirebench.yaml id
    slug: countries
    source: internal                # folder is projects/<slug>
  - id: 01J8K3T…
    slug: payments-git
    source: linked
    path: /Users/me/src/payments/wirebench   # absolute; recorded from a native dialog pick
```

`environments/dev.yaml`:

```yaml
id: 01J8K3R…
name: dev
slug: dev
order: 0
properties:
  baseUrl: https://dev.example.com
endpoints:
  countries/CountryInfo: https://dev.example.com/CountryInfo.wso
```

Rules.
- The workspace list is the directory scan of `workspaces/*/workspace.yaml` (truth on disk); `workspace-state.json` only remembers the last opened id. A folder with a corrupt manifest is listed as *unreadable* with a *Reveal* action, never silently dropped.
- Loading validates every file with zod through the same `exact<T>()` discipline as projects (ADR-0003): an additive field bumps the workspace `formatVersion`. The project `formatVersion` is untouched by this feature.
- Engine types (`packages/engine/src/workspace/model.ts`): `Workspace`, `WorkspaceProjectRef` (`source: 'internal' | 'linked'`), `WorkspaceEnvironment`; all `readonly`, ids ULIDs. `PropertyScopes` gains `workspace: PropertyMap` and `workspaceEnv?: PropertyMap`.

---

## 5. Architecture

**Engine** (`packages/engine/src/workspace/`): pure model + schema + `loadWorkspace(fs, dir)` / `saveWorkspace(fs, dir, ws)` (deterministic serialization, same `FsLike`), `reidentifyProject(project, ids)`, environment linking and endpoint resolution helpers. `project/properties.ts` learns the `Workspace` scope. No Electron.

**Main.**
- `project-service.ts` becomes `project-host.ts`: the same class, one instance **per open project** (autosave, watcher, hydration, id-keyed mutations). It stops owning "the open project" and the recent list.
- New `workspace-service.ts`: scans/creates/opens/closes workspaces, owns `Map<projectId, ProjectHost>`, the `entityId → projectId` index, the workspace manifest writer, environment activation, trash via `shell.trashItem` (in e2e mode: move into `<userData>/trash/` so CI on Linux does not need a trash service), and `workspace-state.json`.
- `recent-projects.ts` is retired; its file is read once by the picker's *Import project folder…* as suggestions.
- Path authority: the workspace folder is a containment root; a linked project root becomes a root only when it was recorded from a native dialog pick and its `wirebench.yaml` parses. The renderer never sends a path.

**IPC** (`shared/ipc.ts`, zod both ways; this spec is the "ask first" for the contract change):
- New `workspace.*`: `list`, `create {name}`, `open {id}`, `close`, `snapshot`, `rename {id, name}`, `delete {id}`, `addProject {name}`, `linkProject` (dialog in main), `importProjectFolder` (dialog in main), `exportProject {projectId}` (save dialog in main), `locateProject {projectId}`, `removeProject {projectId, deleteFiles}`, `setActiveEnvironment {environmentId | null}`, `mutate {change}` (rename, properties, environment CRUD). Event `workspace.changed`.
- Changed `project.*`: `create`, `open`, `close`, `recent` are removed; `snapshot`, `mutate`, `save`, `addInterface`, `reload` take `projectId`; `addInterface` accepts `projectId | { newProjectName }`. Events `project.changed`, `project.changedOnDisk`, `project.hydration` carry `projectId`.
- Unchanged: `request.*`, `attachments.*`, `keystores.*`, `wss.*`, `validate`, `wsi`, `definition.*`, `envelope`, `xml`, `xpath`, `secrets`, `ssl`, `preferences`, `globals`. `history.list` gains an optional `projectId` filter; `search` results gain `projectId`.

**Renderer.**
- New `state/workspace.ts` (zustand): workspace meta, project refs with load status, environments, active environment, the workspaces list for the switcher.
- `state/project.ts` becomes multi-project: `projects: Record<projectId, ProjectSnapshot>` plus the flattened `interfaces` / `requests` indexes that editors already consume, so request-editor, details, inspectors and history code keep their id-based reads. Actions that mutate take the `projectId` they resolve from the entity.
- New `features/workspace/`: picker screen, title-bar switcher, manage dialog, new-project dialog, link/import/export actions. `features/welcome/` is retired. `features/environments/` becomes the workspace grid. Explorer grows project root nodes.
- `shell/title-bar.tsx` gets the switcher; `shell/status-bar.tsx` the environment picker; `ui-state` keyed by workspace id.

**Startup sequence.** `app.ready` → warm engine → `WorkspaceService.openLast()` → hosts created per project, each hydrating in the background → renderer shows the explorer immediately with per-project progress. If `openLast()` fails, the picker is shown with the error.

---

## 6. Security and path safety (extends ADR-0005)

- The renderer never names a filesystem path. Linking, importing, exporting and locating all run their native dialog in main and record the pick.
- Containment roots for the open workspace: `<userData>/workspaces/<id>` and each linked project root (realpath, must contain a parsable `wirebench.yaml`). Attachments, `file:` inlining, `resourceRoot` and definition caches are checked against the owning project's root exactly as today.
- Deletion is trash-only (`shell.trashItem`), always after a confirmation dialog, never for linked folders.
- Secrets stay in `secrets.json` by `secretRef`; workspace files never carry credentials (asserted by the same grep test that guards project folders).
- Importing a copy re-identifies ids so two loaded projects never share an entity id; a link that would duplicate a project id is refused.

---

## 7. Tech stack

Unchanged: Electron + electron-vite, TypeScript strict, React 19, zustand + immer, Radix, react-arborist, Monaco, zod 4, `yaml`, ulidx, vitest, Playwright. **No new runtime dependency is expected**; if one turns out necessary it is an ask.

---

## 8. Commands

```
pnpm dev                          # electron-vite dev
pnpm build                        # typecheck + electron-vite build
pnpm check                        # typecheck, lint, doc/contrast/path/licence/banned-terms checks, unit, perf — the gate
pnpm test                         # vitest (engine + desktop + scripts projects)
pnpm test:coverage                # engine ≥ 85% lines/branches
pnpm test:e2e                     # playwright (Electron, built app); new: e2e/specs/workspace.spec.ts
pnpm test:e2e -- e2e/specs/workspace.spec.ts
pnpm lint && pnpm lint:fix
pnpm typecheck
pnpm screenshots:update           # regenerate docs/images and a11y snapshots after the shell changes
```

---

## 9. Project structure (new or changed)

```
packages/engine/src/workspace/                  ← new
  model.ts · schema.ts · load.ts · save.ts · environments.ts · reidentify.ts · index.ts
packages/engine/src/project/properties.ts       ← Workspace scope
packages/engine/src/project/endpoints.ts        ← workspace env endpoint precedence
packages/engine/test/unit/workspace/            ← unit + golden round-trips
apps/desktop/src/main/
  workspace-service.ts · workspace-state.ts     ← new
  project-host.ts                               ← renamed from project-service.ts, one per project
  recent-projects.ts                            ← retired (read-only import suggestions, then deleted)
  ipc/workspace.ts · ipc/project.ts             ← new / changed
apps/desktop/src/shared/ipc.ts · wire-types.ts  ← contract
apps/desktop/src/renderer/
  state/workspace.ts · state/project.ts · state/ui-state.ts
  features/workspace/ (picker-screen.tsx, switcher.tsx, manage-dialog.tsx, new-project-dialog.tsx, project-actions.ts)
  features/environments/ (workspace grid) · features/explorer/ (project roots) · features/welcome/ (retired)
  shell/title-bar.tsx · shell/status-bar.tsx
  commands/register-workspace-commands.ts
apps/desktop/test/                              ← component tests for the above
e2e/specs/workspace.spec.ts · e2e/helpers/project.ts (create workspace + project by name; no folder pin)
docs/adr/0006-workspaces-in-app-data.md         ← new ADR
docs/architecture/*.md · README.md · docs/images/*.png · CHANGELOG.md
```

---

## 10. Code style

Follows v1 §10 verbatim. One snippet showing the additions:

```ts
// packages/engine/src/workspace/schema.ts
export const WORKSPACE_FORMAT_VERSION = 1 as const;

export const workspaceProjectRefSchema = z.discriminatedUnion('source', [
  z.looseObject({ source: z.literal('internal'), id: nonEmpty, slug: slugSchema }),
  z.looseObject({ source: z.literal('linked'), id: nonEmpty, slug: slugSchema, path: nonEmpty }),
]);

/** `workspace.yaml`. Any additive field bumps `formatVersion` (ADR-0003 discipline). */
export const workspaceManifestSchema = z.looseObject({
  formatVersion: z.literal(WORKSPACE_FORMAT_VERSION),
  id: nonEmpty,
  name: z.string(),
  description: z.string().optional(),
  createdAt: z.iso.datetime(),
  properties: propertyMapSchema,
  activeEnvironmentId: z.string().optional(),
  projects: z.array(workspaceProjectRefSchema),
});
```

```ts
// apps/desktop/src/main/workspace-service.ts
/** Routes an entity-addressed call to the host that owns it; unknown ids are a caller bug, not a crash. */
private hostFor(entityId: string): ProjectHost {
  const projectId = this.index.get(entityId);
  const host = projectId === undefined ? undefined : this.hosts.get(projectId);
  if (host === undefined) {
    throw new WirebenchError('unknown-entity', { entityId });
  }
  return host;
}
```

Conventions specific to this feature: UI copy says *workspace* and *project*, never *collection*; folder names on disk are ids or slugs, never display names; every destructive verb in the UI is *Remove* or *Move to Trash*, never *Delete files*.

---

## 11. Testing strategy

| Level | Location | Cases |
|---|---|---|
| Unit (engine) | `packages/engine/test/unit/workspace` | manifest + environment schema accept/reject; load → save byte-identical golden; `reidentifyProject` rewrites every id and no secretRef; scope chain Env → Project → Workspace → Global with `${#Workspace#x}`; env name-linking and project-wins precedence for properties and endpoints; endpoint key `<project>/<interface>` |
| Unit (main) | `apps/desktop/test/main` | `WorkspaceService`: create/list/openLast/switch; corrupt manifest listed as unreadable; addProject slugs unique; link refused on duplicate id; missing linked folder → error state, `locateProject` repairs it; removeProject trashes internal only; e2e trash dir hook; entity index stays correct across hydration and reload; `workspace-state.json` round-trip |
| Component (renderer) | `apps/desktop/test/renderer` | picker (empty, list, create on Enter); switcher; explorer project roots and states; environments grid edits produce the expected `workspace.mutate` change; status-bar environment picker |
| E2E | `e2e/specs/workspace.spec.ts` | launch → picker → create workspace → new project → import Calculator into it → import CountryInfo as new project → tabs from both open → set `dev` endpoint override for one interface → send uses it → relaunch reopens the workspace → switch to a second workspace and back (tabs restored) → remove internal project (folder in trash dir) → link an exported project folder → delete workspace via manage dialog |
| E2E regression | all 28 existing specs | migrated helpers (`createProjectWithCalculator` creates workspace + project by name); a11y snapshots and docs screenshots regenerated in one dedicated commit |
| Performance | `e2e/specs/perf.spec.ts` | workspace with 10 internal projects × 3 fixture interfaces: picker → explorer interactive < 1.5 s (M1), hydration off the UI thread; workspace switch < 1 s to interactive; existing budgets unchanged |
| Security | engine + main tests | grep of a saved workspace folder finds no password/secret; a renderer-supplied path in any new channel is rejected by zod (no path fields exist) |

TDD for engine and main code; coverage thresholds unchanged (engine ≥ 85%); no test touches the network.

---

## 12. Boundaries

**Always**
- Everything in v1 §12, ADR-0004, ADR-0005.
- Address entities by id across IPC; the renderer never sends a path; every folder dialog runs in main and records its pick.
- Keep the project format at `formatVersion: 1`; keep `wirebench.yaml` in a workspace project identical to a standalone one so *Export* is a copy.
- Deterministic serialization of `workspace.yaml` and environment files (stable key order, atomic write).
- Regenerate a11y snapshots and docs screenshots after shell changes, in their own commit.
- Record the storage decision as ADR-0006; update the v1 design's §6.9/§7 with a pointer to this spec.
- Describe behaviours on Wirebench's own terms (`pnpm check:banned-terms` stays green).

**Ask first**
- Any new runtime dependency.
- A project `formatVersion` bump, or any change to the project folder format.
- Removing further IPC channels beyond the ones listed in §5, or changing default shortcuts.
- CI/release changes; multi-window; workspace sync/sharing of any kind.
- Deleting `recent-projects.json` support before the import-suggestion path has shipped.

**Never**
- `rm -rf` anything under `userData` or a linked folder; deletion is trash-only after confirmation, and never for linked projects.
- Write outside `<userData>/workspaces/<id>` or a dialog-picked folder.
- Block the renderer on hydration; block startup on a broken workspace.
- Put secrets, absolute home paths of other users, or history into workspace files.
- Use the word *collection* or name other tools in UI strings or docs.

---

## 13. Success criteria (done when all are true)

1. First launch shows the workspace picker; creating a workspace by name lands in an empty workspace with no folder dialog anywhere in the flow (e2e).
2. A workspace holds two projects created by *New project* and *Import WSDL → new project*; requests from both are open in tabs simultaneously and both send successfully against the local test server (e2e).
3. Setting the workspace environment `dev` with an endpoint override for one interface changes the URL used by the next send of that interface only; `${#Workspace#x}` expands; project-wins precedence is asserted for a linked project (engine unit + e2e).
4. Relaunch reopens the last workspace with its tabs; switching workspaces round-trips the tab set (e2e).
5. Removing an internal project moves its folder to the trash (e2e trash dir) after confirmation; removing a linked project leaves its folder untouched (main unit + e2e).
6. Linking a folder exported from another workspace works; linking a folder whose project id is already present is refused with a readable message (unit + e2e).
7. A saved workspace folder contains no secret material (grep test), and `workspace.yaml` round-trips byte-identical through load/save (golden).
8. All previously green e2e specs are green after the helper migration on macOS, Windows and Linux; `pnpm check` green; engine coverage ≥ 85%.
9. Performance budgets in §11 met and asserted in `perf.spec.ts`.
10. README quick start, `docs/architecture`, screenshots, CHANGELOG and ADR-0006 describe the workspace flow; no reference to folder-opening remains.

---

## 14. Migration and compatibility

- No shipped release exists, so there is no format migration. Existing project folders are brought in with *Import project folder…* (copy + re-identify) or *Link existing project folder…*. The picker lists the entries of a leftover `recent-projects.json` as suggestions for that import; the file is deleted once empty or ignored if absent.
- `WIREBENCH_E2E_DIALOG_FOLDER` remains for the link/import/export dialogs in tests; project creation no longer needs it.
- Docs that describe "open a project folder" (README, `docs/architecture/*`, images) are rewritten; ADR-0003 gets a one-line note that projects now normally live inside a workspace folder in app data and are exported or linked for git.

---

## 15. Risks

| Risk | Impact | Mitigation |
|---|---|---|
| Multi-project refactor of `project-service.ts` (1.4 K lines) and `state/project.ts` regresses existing flows | High | Rename to `ProjectHost` first with zero behaviour change and the full e2e suite green, then add the workspace layer; entity-id addressing keeps most channels untouched |
| Hydrating N projects at once slows startup | Medium | Hydrate sequentially in the background with per-project progress; explorer renders from manifests before any definition loads; perf budget asserted |
| Name-linked environments confuse users | Medium | Only linked projects have project environments; the Environments grid shows the effective endpoint per interface with its source (workspace / project / interface) |
| Trash unavailable on CI Linux | Low | e2e trash-dir hook; production uses `shell.trashItem` and reports failure without deleting |
| Duplicate entity ids from copied folders | Medium | Re-identify on import; refuse on link |

---

## 16. Open questions (resolved 2026-09-11: the bold default in each line is the decision)

1. Same-name precedence between a linked project's environment and the workspace environment: **project wins** / workspace wins.
2. Project-level environments for internal projects: **hidden, none created** / still available.
3. *Link existing project folder…* ships in this feature: **yes** / later.
4. History view: **merged across projects with a filter** / per project of the active editor.
5. Deleting a workspace: **keeps history files** / trashes them too.
6. Keep user-wide `${#Global#…}` alongside `${#Workspace#…}`: **yes** / fold globals into the workspace.
7. Reopen the last workspace on launch: **yes, picker on failure** / always show the picker.
8. Import WSDL default target when a project is selected in the explorer: **that project** / always ask.
