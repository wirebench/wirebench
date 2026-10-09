# Multi-window: several workspaces open at once — design

**Issue:** #72 · **Date:** 2026-10-08 · **Status:** draft

Lifts assumption 7 of the workspaces design (`2026-09-11-wirebench-workspaces-design.md` §1): "one window,
one workspace" becomes "one workspace per window, several windows".

## Objective

A user with two workspaces (say, a partner integration and an internal service) opens both side by side.
After this change:

1. **File → New Window** (`Mod+Alt+N`) opens a second window at the workspace picker.
2. Each window opens, switches and closes its own workspace. Nothing one window does to its workspace —
   edits, saves, sync, environment switch, cookie jar, current values, secret sources, team secrets,
   audit reporting — reaches the other.
3. A workspace is open in at most one window. Opening one that another window holds focuses that window
   instead and the picker says so.
4. Closing a window keeps its unsaved state exactly as quitting does today: the window hands over its
   staged edits, the workspace closes and records them, and they come back on the next open.

## Singletons found in main

Every module-level object in `apps/desktop/src/main/index.ts`, and whether it is per window after this
change. "Per window" objects live in a `WindowScope`; everything else stays one per app.

| Object | Today | After | Why |
| --- | --- | --- | --- |
| `WorkspaceService` | one, the open workspace | **per window** | the issue |
| `DialogPicks` | one set per session | **per window**, over one app set | the issue; see D4 |
| `CookieStore` | one, follows the open workspace's jar | **per window** | `host()`/`state()` read "the current jar" |
| `CurrentValuesStore` | one, follows the open workspace | **per window** | holds one `currentId` |
| `SecretSourcesService` | one cache, reads the open workspace's mapping | **per window** | cache and `noteChange` key are the workspace's |
| `TeamSecretsService` + `TeamSecretStore` | one, `attach`ed to the open shared workspace | **per window** | holds one `ws` |
| `SecretScanSessions` | one, over `workspaceService` | **per window** | reads its window's hosts |
| `AuditReporter` | one, target follows the open workspace | **per window** | one target and one outbox; `enqueue` drops other workspaces' events |
| window title | every window gets the one title | **per window** | `applyWindowTitle` |
| `WorkspaceState` (`workspace-state.json`) | one per `WorkspaceService` | **one per app**, shared | two queues would race one file |
| `.joining/` sweep | run by every `WorkspaceService` | **once per launch** | a second window must not delete a clone in flight |
| `HistoryService` | one, open/close per project | one per app, **reference-counted** per project | the same linked project folder can be in two workspaces |
| WebSocket/REST exchanges ended on workspace close | every exchange in the app | **that workspace's** exchanges | `closeWsSessions(undefined)` ended every window's sockets |
| REST contract checker worker | disposed on workspace close | disposed when **no** window has a workspace | another window may be checking |
| `PreferencesService`, managed-preferences policy | one | one | app-wide by definition |
| `GlobalProperties` | one | one | globals are app-wide; every window's current values hear a change |
| `EngineService`, `ExchangeRegistry`, `ScriptHost`, `SequenceRunner` | one | one | keyed by entity id, not by workspace |
| `AccountService`, `ServerClient`, `LiveClients`, `HooksService` | one | one | per server or per tab already |
| `OAuth2Service`, `IssuedTokensService` | one | one | caches keyed by configuration; the target lookup routes by project id |
| updater (`createUpdateController`) | one | one | one app, one update; status goes to every window |
| `SecretStore`, `ShowSecretsFlag` | one | one | the keychain and a session toggle |

## Decisions

- **D1. `WindowScope` and `WindowScopes`.** `main/window-scope.ts` builds the per-window objects above for
  one `BrowserWindow` and wires their callbacks to *that* window's `webContents` (the workspace events,
  cookies, current values, team secrets, title). `WindowScopes` keeps them by `webContents.id`.
- **D2. Routing without rewriting every channel.** `registerHandler` runs each handler inside an
  `AsyncLocalStorage` context naming the invoking `webContents`. The objects index.ts hands to the
  `register*Channels` functions become routers:
  - **Entity-addressed** calls (every `ProjectRouter` method, `hostFor`, `hostOfEntity`, `projectId`,
    `issuedTokenTarget`, `importProperties`) go to the window whose workspace holds that id — the caller's
    window first — so a script worker, a sequence step or a token fetch finds its project whatever context
    it runs in. `projectId` of an id no window holds is `undefined`, as today.
  - **Workspace-level** calls (`snapshot`, `mutate`, `open`, `list`, `secretSourcesSnapshot`, cookies,
    current values, …) go to the caller's window. With no caller (a timer, launch) and exactly one window
    they go to that window, so single-window behaviour is unchanged; with several they throw `no-window`
    rather than guess.
  The channel modules keep their signatures; only `index.ts` changes what it passes.
- **D3. Events.** Workspace-scoped events (`workspace.*`, `project.*`, `sync.*`, `git.identityNeeded`,
  `engine.progress`, `cookies.changed`, `currentValues.changed`, `teamSecrets.changed`) go to their own
  window only. Send-scoped events (`exchange.logged`, `exchange.failed`, `history.appended`,
  `sequence.*`, `script.valuesChanged`) go to the window that started the send, or every window when
  there is none. App-wide events (`preferences.changed`, `globals.changed`, `theme.changed`,
  `account.changed`, `app.updateStatus`, `hooks.*`, `history.changed`) still go to every window.
- **D4. Dialog picks.** Each window has its own `DialogPicks`; its `hasRead`/`hasWrite` also accept the
  **app** set. Only what preferences carry goes into the app set — the CA bundle and git executable picked
  in Settings (`ssl.*`, `git.*`), and the ones remembered at launch — because preferences apply to every
  window. A file one window picked to attach, dump to or import is not a pick in another window.
- **D5. One window per workspace.** `WorkspaceService` takes `heldElsewhere(workspaceId)`. `open` (and
  so `openLast`), `rename` and `delete` of a workspace another window holds throw
  `workspace-open-elsewhere` ("That workspace is open in another window."); main focuses that window.
- **D6. Window lifecycle.** The first window of a launch, and the first after every window closed (macOS
  `activate`), reopens the last workspace as today. **New Window** opens at the picker. Closing a window
  runs the quit path for that window alone (flush drafts, at most 2 s; close the workspace; flush cookies;
  dispose its audit reporter) before the window is destroyed. Quitting does it for every window at once
  and the windows then close without repeating it.
- **D7. Entry point.** A renderer command `workspace.newWindow` ("New Window", category Workspace,
  `Mod+Alt+N`; `Mod+Shift+N` is New Project) calls a new `app.newWindow` channel. It is in the File menu through the existing
  command manifest.

## Out of scope

- "Open in New Window" from the picker row, tearing a tab out into a window, restoring every window's
  workspace at launch (only the last one reopens).
- An ad-hoc request's socket (no project) keeps running when its window switches workspace; it ends on quit.

## Testing

- Unit: `WindowScopes` routing (entity by owner, workspace by caller, `no-window` with two and no caller),
  `DialogPicks` parent set, `HistoryService` owners and per-window listing, `WorkspaceService`
  `heldElsewhere` for open/rename/delete and the one-time `.joining/` sweep.
- e2e (`e2e/specs/multi-window.spec.ts`, CI only): open workspace A, New Window, open workspace B in it;
  each window's title and explorer show its own workspace; opening A from the second window is refused
  and the first window gets focus; closing the second window leaves the first untouched.
