# ADR-0021: A desktop area is a module behind one interface

- Status: accepted
- Date: 2026-10-08
- Context: issue #316; `docs/specs/2026-10-08-ssh-area-design.md`, built by
  `docs/plans/2026-10-08-ssh-area-plan.md`. The desktop-side counterpart of ADR-0017. Keeps ADR-0002 (the engine runs
  in main) and ADR-0005 (the renderer never touches the file system), and builds on ADR-0018 (the area is not a product
  boundary).

## Context

The desktop shell named its areas by hand. The activity bar was a hardcoded `ITEMS` array, the sidebar was a ternary
chain over a `SidebarView` union (`'explorer' | 'environments' | 'search' | 'history' | 'wss'`), the sidebar's titles and
empty states lived in a `VIEWS` copy map, and each view's `view.show*` command was registered by hand. A sixth area
meant editing the rail, the chain, the copy map, the type and the command registry, and the shell had no way to leave
one out: nothing could be switched off, so an operator could not ship a build without a feature.

The SSH area (hosts and an interactive terminal) is the first area that brings its own commands, its own editor tab
kind and its own IPC channels. Adding it to the chain would have made every later slice (snippets, SFTP, forwarding)
edit the same shell files again.

## Decision

**One contract, split by process.** An area is an `AreaModule` (`apps/desktop/src/shared/area-module.ts`): its `id`, the
engine `FeatureDescriptor` that switches it, its rail item (label, icon name, the command that shows the view, order)
and the copy its sidebar header and empty state show. The contract is split in three, because the renderer must not
import main-only code and main must not import React:

- the **shared half** (`shared/areas/<id>.ts`) is the `AreaModule` value and imports nothing process-specific;
- the **renderer half** (`renderer/areas/index.ts`, `RENDERER_AREAS`) gives the area's sidebar `View` and an optional
  `registerCommands`, and maps the icon name to the component;
- the **main half** (`main/areas.ts`, `registerEnabledAreaChannels`) registers the area's IPC channels.

**A static list.** `AREAS` in `shared/area-module.ts` is the one ordered list that composes the shared halves, and
`AreaId` is derived from it. `SidebarView` is `AreaId`. The activity bar maps over the enabled areas and the sidebar
looks the view up by id; the ternary chain and the copy map are gone. The five existing views (Explorer, Environments,
Search, History, WS-Security) became modules of the same contract first, as a refactor with no behaviour change.

**A feature switch.** The `WIREBENCH_AREAS` environment variable (`ssh=off,wss=off`) turns areas on and off. Main works
out the enabled set at start-up and the renderer reads it once through `app.areas`. A switched-off area registers no
channels in main and no commands in the renderer, and the activity bar and the sidebar leave it out; a persisted
sidebar view of an area that is off falls back to the first enabled area. Areas are not a product boundary (ADR-0018 is
untouched): the switch is for operators and developers.

**The filter is local to `shared/`.** `shared/` takes only type imports from the engine, so `enabledAreaIds` repeats the
rules of the engine's `createFeatureSet` (a switch beats the default; a feature is off when anything it requires is
off) as a small local function instead of importing it. A value import of `@wirebench/engine` into code the renderer
loads eagerly breaks every e2e run through the CSP check on a schema probe; the descriptor type is still the engine's,
so the two stay aligned in shape.

**`@internal`.** Like the protocol modules, the contract is composed statically in this repository. Nothing loads
third-party code.

## Consequences

- A new area is one shared module value, a renderer entry and a main entry, plus its place in `AREAS`. No shell file
  (activity bar, sidebar, editor area chrome) names it. A test pins the claim by checking the list's order, the derived
  ids and that an off area is absent from `app.areas` and registers nothing.
- Later SSH slices (snippets, SFTP, forwarding) extend the ssh module: new channels, tab kinds and commands, not the
  shell.
- The switch is read from the environment only. An operator setting for it is a follow-up.
- The filter in `shared/` can drift from the engine's `createFeatureSet`. The rules are two lines long and a unit test
  covers them; a parity test against the engine is possible later, from a place that may import the engine's values.
- A loadable plugin API, manifests and sandboxing stay out of scope. The contract may change in any release.
- The `ssh` area is `experimental` until port forwarding ships, then `stable`.

## Alternatives considered

- **Keep the chain and add a sixth branch.** Rejected: it is what made the sixth area an edit to five files, and it
  gives no way to leave an area out.
- **A loadable plugin API with manifests.** Rejected for now (the same call as ADR-0017): nothing needs third-party
  areas, and a promised surface is harder to change than an internal one.
- **Value-importing `createFeatureSet` from the engine in `shared/`.** Rejected for the CSP reason above.
