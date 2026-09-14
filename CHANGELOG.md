# Changelog

All notable changes to this project are documented here. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and the project adheres to
[Semantic Versioning](https://semver.org/spec/v2.0.0.html).

## [Unreleased]

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
[Unreleased]: https://github.com/wirebench/wirebench/compare/v1.1.0...HEAD
[1.1.0]: https://github.com/wirebench/wirebench/releases/tag/v1.1.0
