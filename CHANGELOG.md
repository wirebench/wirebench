# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

### Added

- **WebSocket request kind.** A fourth container beside SOAP, REST and gRPC, in the same project, workspace,
  environments, history and search. *New WebSocket API…* takes a `ws://` or `wss://` URL; a request under it
  connects with headers, query parameters, subprotocols, the shared auth kinds that are a header or query
  value, the resolved proxy, a client certificate and the custom CA bundle. Every frame — sent or received,
  text or binary, control or data — appears on a live timeline as it arrives, with a pretty-printed view for
  JSON or XML text one toggle from the raw bytes. While connected, the composer sends a typed or saved
  message (`${…}` properties expand at send time); *Disconnect* closes with a chosen code (1000 or
  3000–4999) and reason, and the close frame and every ping/pong show as control rows. The handshake is one
  HTTP Log entry (`GET`, its headers, the `101` or the refusal, timing and TLS); the session appears in
  History when it closes, capped to its first 400 and last 100 frames within 1 MB — History's own re-send
  stays offered for a SOAP entry only. `kind: websocket` writes under the existing `formatVersion: 3`; a
  project without a WebSocket API is byte-identical to before. See
  [`docs/specs/2026-09-19-websocket-request-kind-design.md`](docs/specs/2026-09-19-websocket-request-kind-design.md)
  and the update to [ADR-0007](docs/adr/0007-apis-beside-interfaces.md).

- **Fleet-ready releases.** An MSI installer for Windows x64 and arm64, for Intune and other fleet
  tools (`msiexec /qn`); a CycloneDX SBOM with every release; build and SBOM attestations on tagged
  releases, checked with `gh attestation verify`. Windows signing through SignPath Foundation is wired
  into the release workflow and switches on with its secrets. Silent installs and download
  verification are on the install page, and the site has a code-signing policy.
- **User guide.** A documentation site at https://wirebench.github.io/wirebench/: install and first run on
  macOS, Windows and Linux, a ten-minute walkthrough, a guide for every feature area, a command and
  shortcut reference generated from the app, troubleshooting and an FAQ. It is published from `main` on
  every push, and its screenshots are shot from the app by the e2e suite.
- **Switching guide.** A Switching section on the site, one page per source — Postman collections,
  legacy SOAP projects, OpenAPI and Swagger, and cURL commands — each saying what carries over, what
  does not, and where the equivalent lives in Wirebench.
- **cURL import reads `--json`, `-G` and `-I`.** `--json` becomes a JSON body with its two headers,
  `-G` moves the data into query rows, and `-I` asks for HEAD.
- **CLI runner: `wirebench run` and `wirebench secrets list`.** A new package, `@wirebench/cli`
  (binary `wirebench`), runs the requests already saved in a project from a pipeline: `status`,
  `soap-fault`, `match` (XPath/XQuery/JSONPath), `schema` and `sla` assertions declared per request;
  `cli`, `junit`, `json` and `html` reports; secrets resolved from `WIREBENCH_SECRET_<NAME>` /
  `WIREBENCH_SECRET_<REF>` environment variables, never from the desktop's keychain-backed store;
  and exit codes a pipeline can branch on (0 pass, 1 assertion failed, 2 usage/load, 3 run error,
  130 interrupted). gRPC unary and OAuth2 client-credentials are not in this release. See
  [`docs/cli.md`](docs/cli.md) and
  [`docs/specs/2026-09-18-cli-runner-design.md`](docs/specs/2026-09-18-cli-runner-design.md).

  **Project format moves to version 4.** Saving a request now carries an optional `assertions:`
  list and an optional `…Env` name beside a `passwordRef`/`tokenRef`/`valueRef`/`clientSecretRef`.
  Both are additive, and a version-3 project migrates in memory without any data moving — but
  because this format drops unknown keys on save, **saving a project with this version writes
  `formatVersion: 4`, and an older Wirebench refuses to open it** (`format-too-new`). Everyone
  working on a project a 2.2+ build has saved needs to be on 2.2 or later too.
- **CI recipes for the runner.** `@wirebench/cli` and `@wirebench/engine` are published to npm; a
  container image is published to `ghcr.io/wirebench/wirebench-cli` (`linux/amd64` +
  `linux/arm64`); a GitHub Action (`wirebench/wirebench/action@<tag>`) and a GitLab template
  (`templates/gitlab/wirebench.gitlab-ci.yml`) wrap them. All four ways to run in CI map secrets
  to `WIREBENCH_SECRET_<NAME>` the caller sets — none of them holds or asks for one itself. See
  ["Run in CI"](docs/cli.md#run-in-ci) and
  [`docs/specs/2026-09-19-ci-recipes-design.md`](docs/specs/2026-09-19-ci-recipes-design.md).
  Publishing itself waits on the first tagged release after the npm organisation and the GHCR
  package's visibility are set up (see ["Before the first publishing
  release"](docs/release.md#before-the-first-publishing-release)).
- **HTTP Log: rows kept and Preserve log.** The number of rows kept is a setting (Preferences › Behaviour,
  100–5000, default 500). Preserve log keeps the rows in memory across closing or switching a workspace;
  it is never written to disk and is off again at every launch.
- **HTTP Log: compare two rows.** Cmd/Ctrl+click a second row to compare the two — a summary of each,
  request and response headers marked added/removed/changed, and request and response bodies side by
  side (pretty-printed when both are JSON or both XML). Escape goes back to one row.
- **HTTP Log: waterfall.** A Waterfall column shows each row's start and duration across the rows shown,
  split into connect, TLS, wait and download (hover for the breakdown; hidden while a row is selected); the
  Timing tab notes a reused connection.
- **HTTP Log: search, a Name column and sort.** Search matches headers, bodies (first 256 KiB) and the
  request name, with regex and match-case toggles; a Name column shows the saved request; click Time,
  Name, Status, ms or Size to sort.
- **HTTP Log: Export HAR.** Saves the rows the filter shows, in display order, as a HAR 1.2 file;
  headers, URL parameters, WS-Security passwords and JSON/form secrets are always masked, whatever
  the show-secrets toggle says. Failed sends carry an `_error`, truncated bodies `_truncated`.
- **HTTP Log row menu.** Right-click a row, press its detail's ⋯ button or press Shift+F10 on the selected
  row to copy it as cURL (POSIX or PowerShell) from what was sent, copy its URL, request or response headers
  or response body, resend the saved request as it is now, or open the request.
- **HTTP Log: failures before the request is built.** A send that fails before the request is built (invalid URL,
  proxy lookup, OAuth2 token fetch) now appears as a "Failed · before send" row, and its detail says the request
  never went on the wire.
- **Importing a legacy single-XML SOAP project.** _Import Legacy SOAP Project…_ (or _Legacy SOAP project_ in
  _Import…_, which also detects the file) brings a whole project file from an older SOAP workbench into a
  Wirebench project. It carries across the SOAP interfaces with their endpoints, every saved request (envelope
  unchanged, and gzip-compressed envelopes decoded), usernames, timeouts, encodings, project properties, and
  environments with their endpoint overrides. Each interface resolves from the definition the file carried, so
  the import works offline and the project reopens offline. What does not come across is listed in a report you
  can copy: passwords (to be re-entered), test suites, mock services, REST services, WS-Security and auth
  profiles. Scripts are kept, never run, under `imported-scripts/`. Picking such a file as a plain WSDL now says
  which format to choose instead of failing partway through.

- **Completion in the gRPC message editor.** Typing a key in the Message tab offers the fields of the message
  the cursor is in — not just the method's request type, so a nested field's own fields are offered inside it,
  and a repeated field's items are offered like the field itself. Accepting one writes the key with an empty
  value of the right JSON shape, and the suggestion carries the declared type, the field's `.proto` comment and,
  for an enum, its values. A key the object already holds is not offered, nor is the rest of a `oneof` whose
  member is already written. Other JSON editors in the app are unchanged. See
  [`docs/specs/2026-09-18-grpc-message-completion-design.md`](docs/specs/2026-09-18-grpc-message-completion-design.md).
- **gRPC live streaming and interactive bidirectional send.** A streaming call now shows itself while it runs:
  the response pane raises its tabs as soon as the call opens, the server's initial metadata appears when its
  headers arrive, and each reply is appended as it is decoded rather than all of them at the end. For a method
  whose client streams, *Open stream* starts the call and leaves the request side open — a composer under the
  response pane sends one more message at a time and *Half-close* stops sending without ending the call, so a
  bidirectional method can be held as a conversation. Every message pushed by hand is part of the exchange that
  is recorded, in `requestMessages` and in the raw request bytes. See
  [`docs/specs/2026-09-18-grpc-live-streaming-design.md`](docs/specs/2026-09-18-grpc-live-streaming-design.md).
- **gRPC server reflection.** Point Wirebench at a running gRPC server and it describes itself: the Import
  dialog's gRPC format gains a *Server* tab taking an address, the reflection version (automatic by default —
  `grpc.reflection.v1`, falling back to `v1alpha`) and whether to ask a server whose certificate does not verify.
  What comes back builds the same folder-per-service, request-per-method API a `.proto` import builds, and is
  cached with the project as the descriptor set the server sent. The gRPC API tab's Definition card gains
  *Refresh from server*: asking again adds a request for a method the server has gained and badges one whose
  method is gone, never deleting anything. The `grpcurl` line for a discovered API names no `.proto` files, since
  grpcurl asks the server itself. See
  [`docs/specs/2026-09-17-grpc-server-reflection-design.md`](docs/specs/2026-09-17-grpc-server-reflection-design.md).
- **gRPC.** A third protocol beside SOAP and REST, in the same project, workspace, environments, history and
  search. Import a `.proto` set (URL, file or paste; imports resolve from beside the root and the bundled
  `google/protobuf/*` types are built in) and get a gRPC API with a folder per service and a request per method,
  each seeded with a sample message; or start from *New gRPC API…* and a target. The editor picks the method from
  the definition, edits the message as JSON in the protobuf JSON mapping, carries metadata, auth and settings
  (deadline, size cap, TLS trust, bind address), and sends every streaming shape over HTTP/2; the response pane
  leads with the gRPC status and lists every reply with its initial and trailing metadata, timing, TLS and the raw
  exchange. Environments override a target the way they override a base URL; the Code slide-over and *Copy as
  Command* produce a `grpcurl`-style line. See
  [`docs/specs/2026-09-16-wirebench-grpc-client-design.md`](docs/specs/2026-09-16-wirebench-grpc-client-design.md)
  and the update to [ADR-0007](docs/adr/0007-apis-beside-interfaces.md).

- **HTTP Log: failed sends, a filter bar and detail tabs.** A send that fails before a response
  arrives (DNS, refused connection, TLS, proxy, timeout, abort, too many redirects) now gets a row
  in the console's HTTP Log, with the error code in the status column, the time it took to fail,
  and the request as it was about to go on the wire (final URL, headers with auth applied, raw
  request) — redacted when recorded and kept so. The log gained a
  *proto* column, a filter bar (URL text; method, status-class and protocol chips, with *failed*
  among the classes; an "n of m" count; *Reset*), ↑/↓ row selection, and a detail pane in five
  tabs: Headers, Request, Response, Timing (each unmeasured phase says why) and Connection
  (redirect hops and the TLS peer). The response pane header and Problems behave as before.

### Changed

- The HTTP Log's fixed 500-row limit is replaced by that setting.
- **Dependencies.** The engine now depends on `protobufjs` (BSD-3-Clause) for `.proto` parsing and message
  encoding; every JSON-mapping rule the editor relies on is applied in-house on top of it.

### Fixed

- **Postman import says what it left behind.** The summary lists the scripts, variables, credentials
  and auth types a collection could not bring across, with **Copy report**; before, they were computed
  and never shown. An OAuth 2 password or implicit grant is reported instead of silently becoming
  client credentials, and `{{var}}` in auth fields is translated like every other field.
- **A pasted `curl -u user:password` keeps the password**, stored as a secret, so the request
  authenticates on its first send instead of asking for the password again.
- **cURL flags no longer swallow the URL.** Value-less flags such as `--ntlm`, `--digest` and `-O` left
  the REST import without a URL, and a flag with a value such as `-o out.xml` made the file the SOAP
  endpoint. Bundled flags (`-sSL`, `-XPUT`, `-uada:pw`) are read as curl reads them.
- **The cURL preview follows its target.** A REST import previews the method, URL, headers, body kind
  and Basic user, without the SOAP-only warnings about `-u` and `-d @file`; the toast after an import
  names each ignored flag instead of counting them.

- **HTTP Log: a REST row follows the show-secrets toggle.** Turning _show secrets_ on or off now
  re-renders the selected REST row too, as it already did for SOAP; before, a REST row kept the
  redaction it had at send time (#50).
- Redaction masks `password`, `token`, `client_secret` and similar keys in JSON and form bodies, not only in XML.
- HTTP Log: ↑/↓ keep the selected row in view when fewer than 200 rows are shown.

## [2.1.1] - 2026-09-16

### Changed

- **Documentation.** The README's screenshots are re-shot against 2.1.0: the explorer as it looks
  now (fold chevrons, the method column, the tighter nesting) and the unified *Import…* dialog in
  place of the retired *Import WSDL…* entry. The capture spec dismisses the folder watcher's
  "changed on disk" banner first, so a picture no longer documents a bar the reader will not see.

## [2.1.0] - 2026-09-16

### Added

- **Shared workspaces.** A workspace can now be shared with a team: *Share this workspace…* turns
  it into a git repository (remote optional, branch default `main`) or moves it into a synced
  folder; *Join shared workspace…* clones one from a URL or opens an existing clone or synced
  folder. Every save becomes a commit with a generated message; a status-bar Sync badge and panel
  pull, push, fetch and show recent commits; a conflict resolver lists each conflicted entity with
  *Keep mine* / *Keep theirs* / *Open file*. Environments now travel with the workspace like
  everything else. See [`docs/collaborate.md`](docs/collaborate.md) and
  [ADR-0008](docs/adr/0008-shared-workspaces-are-git-repositories.md).

- **Not on this machine.** In a shared workspace, a request field whose secret ref has no value on
  this machine shows *Not on this machine* with an *Enter…* button; the value you type is stored
  locally under the same ref, so the shared files and your teammates' files never change.

- **Git preferences.** Preferences → Git shows the git executable Wirebench will run and its
  version, with *Locate…* to pick a specific binary and *Clear* to return to automatic discovery.

### Changed

- **Workspace format `3`.** `activeEnvironmentId` moves out of `workspace.yaml` into a
  machine-local `local.yaml` (it was never meant to be shared between members), and `writtenBy` is
  dropped from the manifest entirely. A version-2 workspace still opens and lifts its active
  environment on first open; a version-3 workspace is refused by an earlier build with the existing
  "created by a newer version of Wirebench" error. A shared workspace also gains a machine-local
  `share.yaml` (remote, branch and sync settings) alongside it, never written into the shared tree.

### Known limitations

- **Line-level merges.** Two edits to the same request's envelope (or any other single file) can
  still conflict at the line level even though one file is one entity; the conflict resolver
  covers this today, a YAML-aware merge driver is a listed follow-up.

- **No shared secret values.** Secret refs travel with a shared workspace; the values behind them
  stay per member. Shared, encrypted secret values are a follow-up for Wirebench Server.

- **Not every missing secret raises the named error.** A missing endpoint password or WSDL-import
  password fails at send time with a message naming the field; a missing keystore passphrase,
  proxy password, or WS-Security secret fails silently instead — check the field for *Not on this
  machine*.

- **Synced folders have no merge.** A `folder` share has no Sync control; two members saving the
  same file race on whatever the folder's own sync tool does about it, usually last-write-wins.

## [2.0.0] - 2026-09-14

The major version is the project format: a project this release has saved carries
`formatVersion: 3`, which a 1.1.0 build refuses to open. Everything a 1.1.0 project holds is
still read and rewritten in place.

### Added

- **REST client.** A project can now hold **APIs** beside its SOAP interfaces, each with folders and
  requests of its own, and the whole shell works the same for both: one explorer, one set of
  environments, one History, one search, one HTTP stack.
  - **Import an OpenAPI document** — *Import OpenAPI…* (`Mod+Shift+I`), from a URL or a file, 3.0 and
    3.1, YAML or JSON, with `$ref`s followed across documents. Operations become requests grouped
    into folders by their first tag, with path and query parameters as tables (required ones on,
    optional ones off), a request body sampled from the schema, and the document's security schemes
    recorded as the API's auth. The import summary lists what it could not map, and the document is
    cached beside the API byte for byte so *View document* and *Export…* give back exactly what was
    fetched. Or skip the document entirely: **New API** takes a name and a base URL, **New Request**
    a method and a path.
  - **Send anything.** Every method; JSON, XML, text, form, multipart and binary bodies; `{param}`
    path parameters; per-request headers and cookies; redirects followed and listed. The response
    pane shows status, duration and size, a pretty and a raw body, headers, cookies, the redirect
    chain, a timing breakdown and the TLS details — and the raw bytes of both directions.
  - **Auth per API, folder or request, inherited down the tree.** Basic, NTLM, Bearer token, API key
    (header or query) and OAuth2 — authorization code with PKCE through a loopback listener, or
    client credentials — with refresh handled for you. Nothing secret is written into a project:
    every credential is a reference to the OS keychain, and a token is redacted everywhere unless
    *show secrets* is on.
  - **Everything the SOAP side already had.** `${…}` property expansion in the URL, tables, headers
    and body; environment endpoint overrides that repoint an API's base URL; unresolved references
    and unfilled path parameters blocked before Send with a Problem; every send in History with its
    method badge; workspace search over URLs, tables and bodies; *Copy as cURL* and **Import cURL**
    both ways; and the response **Query** view, now over JSON as well as XML.
- **Query a JSON response.** The response Query view offers **XPath 3.1**, **XQuery 3.1** and
  **JSONPath** over a JSON body (the parsed document is the context item for the first two; `$` for
  the third). A JSONPath result shows the path each match was found at. An XML response is
  unchanged — XPath and XQuery, with the namespace table.
- **Reorder editor tabs.** Drag a tab to a new place in the strip, or move the active tab with
  *Move Tab Left* / *Move Tab Right* (`Mod+Shift+PageUp` / `Mod+Shift+PageDown`, or
  `Mod+Shift+←` / `→` on a focused tab). The order is kept with the workspace's tabs.
- **Explorer fold state is remembered per workspace.** Which projects, interfaces, bindings and
  operations are expanded or collapsed survives a workspace switch and a relaunch.
- **Request path.** The request editor shows where the request lives — *Project / Interface /
  Operation / Request* — above its toolbar, with the SOAP version badge (SOAPAction on hover) at
  its right. Double-click the request's name there to rename it in place.
- **Tab strip without a scrollbar.** When the open tabs do not fit, chevrons at either end page
  the strip along, the mouse wheel scrolls it sideways, and a menu at the far right lists every
  open tab. Long tab names are truncated, with the full name on hover.

### Changed

- **Project format version 3 — this is a one-way door.** A project gains an `apis/` tree beside
  `interfaces/`, so `formatVersion` moved to `3`. A version-1 or version-2 project opens unchanged
  and is rewritten at version 3 the next time it is saved. After that, **a 1.1.0 build can no longer
  open it** — it sees the newer version and refuses with "created by a newer version of Wirebench" —
  and that applies whether or not the project actually holds an API. Keep a copy if you need to go
  back.
- **Unsaved changes are never written behind your back, and never lost.** Quitting, or
  switching to another workspace, no longer saves your projects. Everything unsaved — request
  edits in tabs as well as properties, auth, endpoints, settings and renames — is kept with the
  workspace and comes back, still marked unsaved, the next time it opens; it is kept current while
  the app runs, so it also survives a crash or a force-quit. If a project changed on disk in the
  meantime, your unsaved changes are restored on top and a notice names the files that changed
  (or were deleted and so dropped). Only Save, Save All or autosave write a project.
- The explorer tree now starts collapsed below the project level, so a newly imported WSDL
  arrives as a single folded interface row; its project is unfolded so the row is visible.
- The request pane's right-click menu is shorter. *Validate request* stays on the toolbar and
  *Show code* in the right rail; *Recreate*, *Create empty*, *Clone* and *Copy as cURL* are still
  in the explorer's request menu and the command palette.
- The request toolbar's *Show code* icon is gone; the right rail's Code icon opens the same panel.
- The request toolbar no longer shows the operation's name or SOAP version; both are in the
  request path above it.

### Fixed

- *Recreate* run from the command palette now keeps an edit typed a moment before, instead of
  rebuilding the envelope without it.
- *Copy as cURL* now describes what is on screen, not the last-saved request: an unsaved edit to the
  URL, tables, headers or body is in the command it gives you.
- A redacted value in an exported cURL command is readable again; it used to arrive
  percent-encoded as `%3Credacted%3E` inside the URL.
- *Remember the refresh token* now responds to the click immediately instead of waiting for a round
  trip, so a quick tick no longer looked ignored.
- A REST send now appears in the console's HTTP Log and in the status bar's *last:* indicator. Both
  are shared with SOAP and both used to keep saying nothing had been sent while a REST response sat
  on screen.
- Durations read as `16 ms` rather than `15.645407999999861 ms` in the status bar, the HTTP Log, the
  response header line and History.
- *Save attachment as…*, *Save response as…*, *Open attachment* and *Save as…* for text now write the
  way every project file already did: to a temp file renamed into place. A crash mid-write no
  longer leaves a truncated file at the path you chose, and nothing watching that path can see it
  before it is whole.

### Dependencies

- Added `jsonpath-plus` (MIT), for the Query view's JSONPath language — with `jsep` and two of its
  plugins (all MIT) beneath it. It runs only in the main process; the renderer bundles neither it nor
  `fontoxpath`. Filter expressions are evaluated by `jsep`, never by the platform's `eval`.

## [1.1.0] - 2026-09-12

### Added

- **Workspaces.** Wirebench now groups any number of projects into a workspace stored under
  Electron's `userData`, with no folder to manage — the launch picker creates or opens one by
  name. A workspace holds its own environments, shared by every project it contains, with a
  `${#Workspace#…}` property scope; an interface's effective endpoint is the workspace
  environment's override, falling back to a linked project's own (name-matched) environment,
  then the interface's default. *Link existing project folder…* and *Import project folder…*
  bring an external project in for teams that keep it in git; *Export project…* writes it back
  out. Removing a project is trash-only and confirmed; a linked project's folder is never
  touched. Tabs, the explorer, and History span every project in the open workspace, and the
  last-open workspace (with its tab set) reopens on launch.

- **Environments view.** Environments moved out of the right panel into their own left-menu view
  (activity bar → *Environments*, `view.showEnvironments`), listing Globals, the workspace and
  every environment; opening one shows a variables table and an endpoint-overrides table, Postman
  style, instead of a grid.
- **Per-variable enabled checkbox.** Every property scope — project, environment, workspace,
  workspace environment, and globals — can now disable one variable without deleting it; an
  unticked variable's value stays on disk but is skipped during resolution, falling through to
  the next scope down.
- **Project tab.** Selecting a project row opens it as a normal pinned tab instead of a side
  panel, showing the project's own settings and properties.
- **Code slide-over.** A right icon rail replaces the old right panel; its one icon today opens a
  slide-over showing the active request as `curl` (`view.toggleCode`, `Mod+Alt+B`, the shortcut
  freed by the removed Details-panel toggle), closed by Escape or the rail icon again.
- **Collapsible, resizable panels.** The sidebar, console and Code slide-over can each be
  collapsed and resized by dragging their handle, by the chevron in the panel's own header or its
  status-bar toggle, or by double-clicking the handle to snap collapsed or restored. Dragging the
  sidebar's or the console's handle past the panel's minimum closes it, and dragging the same
  handle back out reopens it; sizes and collapsed state persist across a relaunch.
- **Environment selector in the title bar.** The active-environment switcher moved from the status
  bar to the top-right of the title bar, beside the theme toggle.
- **Preferences dialog.** Settings open as a modal dialog from the activity bar's foot (or
  `preferences.open`) instead of a sidebar list plus an editor tab.
- **Per-tab save.** `Mod+S` saves the request tab in front of you, and each tab shows its own
  unsaved dot; *Save All* (`Mod+Alt+S`) saves every open project. The project tab shows
  *Unsaved changes* / *Saving…* / *Saved* beside the project name.
- **Autosave preference.** *Preferences → Editor → Autosave projects* turns autosave back on;
  turning it on mid-session writes any outstanding edit straight away.
- **Code panel highlighting.** The `curl` / PowerShell preview is rendered as highlighted code,
  with flags, strings and heredoc bodies told apart.

### Changed

- **Saving is manual by default.** Edits stay in the open project until you save; closing a
  project or quitting still writes it. Enable the autosave preference above for the old
  behaviour.
- **One click opens.** Explorer requests and environments open on a single click; the environment
  being edited is highlighted in the Environments list. *Open* is gone from their context menus.
- **Context menus are grouped** with separators, and *Clone* sits with *Rename* and *Delete*.
- **Release artifact names** carry the OS and architecture (for example
  `Wirebench-1.1.0-mac-universal.dmg`, `Wirebench-1.1.0-windows-x64-setup.exe`); macOS ships
  universal, Intel and Apple-silicon builds, and Linux gains a `.snap`. See `docs/release.md`.
- **Project and workspace format, `formatVersion: 2`.** The per-variable enabled flag above is an
  additive format change: `properties` stays a plain `name -> value` map, and a sibling
  `disabled:` list of names sits beside it, sorted, deduplicated, and omitted entirely when
  empty. A version-1 file (no `disabled` key) still opens and migrates as "all enabled". **A
  1.0.0 build cannot open a project or workspace saved by this version** — it refuses
  `formatVersion: 2` with its existing "created by a newer version of Wirebench" error.
- **Global properties file, `version: 2`.** The same `disabled:` list, for the global scope's
  properties file in app data.

### Removed

- **Opening or creating a project by picking a folder.** The Welcome-screen "Open Project…" and
  folder-picker "New Project" flows are gone; a project is now created by name inside a
  workspace, and a folder dialog only appears for linking, importing or exporting a project.
- **The right panel.** Its contents moved, each to where it belongs: the request's interface,
  operation, SOAPAction, resolved endpoint (and which layer it came from) and project are now the
  request editor's *Details* inspector — one of the strip's inspectors, alongside the *Auth*,
  *WS-A*, *Attachments*, *Headers*, *Properties* and *SSL* inspectors that already existed;
  interface-level settings are in the interface tab, project settings and properties in the
  project tab, environments in the Environments view, and the Code view in the right-rail
  slide-over above. `view.toggleDetails` is gone.

### Fixed

- `Mod+S` pressed straight after typing saved the envelope as it was before the last keystrokes,
  and *Save All* could report success while staged request edits stayed unsaved.
- `Mod+S` with the caret in the request editor kept saving the first tab opened after switching
  tabs; go-to-definition had the same stale-tab lookup.

## [1.0.0] - 2026-09-11

First release: **Explore & Send**. Import a WSDL, understand it, build a request from the
contract, send it with whatever the service demands, and read the answer.

### Added

**WSDL and XSD**

- WSDL 1.1 parsing with `wsdl:import`, `xs:import` and `xs:include` resolved recursively from
  URLs or the filesystem, with a byte-exact local cache and a manifest recording origin and
  sha256.
- Schema sets over the imported documents: type resolution, substitution groups, element and
  attribute lookup, and position-aware queries used by editing and completion.
- Interface viewer, generated documentation, definition export, and Update Definition — which
  re-fetches a contract, reports what changed per operation, and can keep edited values.

**Request generation**

- A sample request for every operation: document/literal (wrapped and bare), rpc/literal and
  rpc/encoded, SOAP 1.1 and 1.2, header parts, `xsi:type` for abstract types, enumeration
  comments, optional-element and sample-value toggles, and the correct SOAPAction spelling per
  version.
- A form model over the same schema, so a request can be filled in as fields instead of XML and
  round-trips back to the envelope.
- `curl` import and export.

**Sending**

- HTTP over undici with raw request and response bytes captured, a timing breakdown, redirects,
  compression, encodings, per-request timeouts and mid-flight cancellation.
- Authentication: HTTP Basic (preemptive and on challenge) and NTLMv2, per request or per
  endpoint, with override/complement semantics.
- TLS: custom trust anchors and client certificates per endpoint, an SSL Info inspector, and a
  per-endpoint (never global) option to send to an endpoint whose certificate does not verify,
  badged permanently in the UI.
- Proxy support, including proxy authentication.

**WS-Security, WS-Addressing, attachments**

- Outgoing: Timestamp, UsernameToken (text and digest), Signature with the full key-identifier
  matrix (RSA-SHA256 and legacy options), and Encryption (AES-256-GCM with RSA-OAEP, plus legacy
  CBC). Verified against `xmlsec1` in CI.
- Incoming: signature verification and decryption, with a WSS inspector showing the result.
- PKCS#12 and PEM keystores, with passphrases held in the OS keychain.
- WS-Addressing headers for both versions, auto-enabled from `wsaw:UsingAddressing`.
- MTOM/XOP and SwA attachments, inline `file:` and `cid:` references, and response attachments
  listed and openable.

**Validation**

- XSD validation of requests and responses via libxml2 (WASM), with problems mapped to exact
  line and column markers.
- A WS-I Basic Profile subset check for both WSDLs and messages, with assertion ids, an HTML
  report export, and the implemented list published in `docs/ws-i-assertions.md`.

**Projects, environments, history**

- Folder-based project format (`formatVersion: 1`): YAML for configuration, XML for envelopes,
  one concept per file, stable key order — renaming a request touches exactly two files.
- Environments with per-environment endpoints and properties; property expansion across global,
  project, environment and request scopes, with unresolved expansions surfaced in Problems.
- History of every send, outside the project folder, with re-send and diff, surviving restart.
- Secrets in `safeStorage` behind `secretRef` ids; no secret ever reaches a project file, a log,
  an export or the renderer.

**The IDE shell**

- Sidebar with explorer, search, history, trust and settings views; editor tabs; a details panel;
  a console with HTTP log, problems, WS-I report and errors; a status bar.
- Monaco everywhere text is edited, with XML, Form, Outline and Raw views for requests and an
  additional Query view (XPath 3.1 and XQuery 3.1) for responses.
- A command palette listing every command, full keyboard navigation of the import→send flow, and
  dark and light themes with a contrast-checked token palette.

**Quality and release**

- `pnpm check` (lint, typecheck, docs check, contrast check, tests, performance budgets) on
  macOS, Windows and Linux in CI, with the engine held at ≥ 85% coverage.
- A Playwright suite driving the built app — and, in `packaged.spec.ts`, the packaged one.
- An `xmlsec1` cross-check job, and a nightly interop suite against four live public services.
- electron-builder packaging for all three platforms with six hardened Electron fuses, an opt-in
  consent-gated update check, and a tag-driven draft-release workflow.
- Documentation: quick start with screenshots, architecture overview, security model, ADR-0001 to
  ADR-0005, and a success-criteria evidence table.

### Known limitations

- The theme screenshot comparison runs on macOS only; the rest of the e2e suite runs on all three
  platforms.
- The `xmlsec1` cross-check needs `xmlsec1` installed, so locally it is skipped unless
  `WIREBENCH_REQUIRE_XMLSEC=1`; CI always runs it.
- The interop suite covers four public services, not five: crcind's SOAP.Demo was unreachable both
  when fixtures were captured and when the suite was written.
- Keystores are PKCS#12 and PEM; JKS is planned. NTLM is NTLMv2 only; SPNEGO/Kerberos is planned.
- English only.

<!-- 1.0.0 was never published; its tag and draft release were withdrawn in favour of 1.1.0. The links resolve once `v1.1.0` is pushed (see docs/release.md). -->
[Unreleased]: https://github.com/wirebench/wirebench/compare/v2.1.1...HEAD
[2.1.1]: https://github.com/wirebench/wirebench/compare/v2.1.0...v2.1.1
[2.1.0]: https://github.com/wirebench/wirebench/compare/v2.0.0...v2.1.0
[2.0.0]: https://github.com/wirebench/wirebench/compare/v1.1.0...v2.0.0
[1.1.0]: https://github.com/wirebench/wirebench/releases/tag/v1.1.0
