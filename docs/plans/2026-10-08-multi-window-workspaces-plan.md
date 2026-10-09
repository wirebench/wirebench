# Multi-window workspaces (#72) — plan

Design: `docs/specs/2026-10-08-multi-window-workspaces-design.md`. One commit per task, each after
`WIREBENCH_SKIP_PERF=1 pnpm check` is green.

## Tasks

1. **Shared pieces made window-safe** (unit tests first).
   - `DialogPicks` takes an optional parent set; `hasRead`/`hasWrite` accept a parent pick.
   - `HistoryService.open`/`close` reference-count per project id.
   - `WorkspaceService` deps: `state` (one shared `WorkspaceState`), `sweepJoining` (default true),
     `heldElsewhere(workspaceId)`; `open`/`rename`/`delete` refuse `workspace-open-elsewhere`;
     `dispose()` drops the accounts listener.
2. **`window-scope.ts`** (unit tests first).
   - `WindowScopes<S>`: add/remove by `webContents.id`, `run(sender, fn)` in an `AsyncLocalStorage`
     context, `current()` (caller, else the only scope, else `no-window`), `owning(id)`, `all()`.
   - `routeWorkspaces(scopes)`: entity-addressed methods by owner, the rest by caller.
   - `scoped(scopes, pick)`: a per-window object (picks, cookies, current values, …) by caller.
   - `registerHandler` runs every handler inside `windowContext.run(sender, …)`.
3. **Main wiring** (`index.ts`, `windows.ts`).
   - `createWindowScope(window)` builds the per-window objects with callbacks to that window.
   - The `register*Channels` calls get the routers; app-wide picks for `ssl.*`/`git.*`.
   - Events per design D3; `closeWsSessions` matches the closing workspace only.
   - Lifecycle: first window reopens the last workspace; window `close` runs the per-window quit path;
     `before-quit` runs it for every window; `activate` reopens.
   - `app.newWindow` channel; `workspace-open-elsewhere` focuses the holding window.
4. **Renderer command** `workspace.newWindow` (Mod+Alt+N) in the catalog and the workspace commands;
   regenerate the command reference.
5. **e2e and docs.** `e2e/specs/multi-window.spec.ts` (CI only); user docs page on workspaces,
   CHANGELOG, roadmap line, workspaces design assumption 7 marked lifted.
