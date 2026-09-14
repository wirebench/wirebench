# Tasks: Full Documentation Site with Live Screenshots

## Task 1: Complete 5-Minute Quickstart with Live Screenshots
**Description:** Expand `getting-started/quickstart.md` with in-depth step-by-step instructions and embed four live screenshots illustrating the user's first journey: opening a workspace, importing a WSDL, editing the envelope, and viewing the response.

**Acceptance criteria:**
- [x] Numbered `<Steps>` walkthrough covers workspace launch, project creation, WSDL import, envelope editing, and response analysis.
- [x] Embeds `workspace-picker.png`, `import-wsdl.png`, `request-editor.png`, and `response.png` with captions.
- [x] Uses `<Shortcut>` chips for keybindings (<kbd>Cmd</kbd>+<kbd>Enter</kbd>, <kbd>Cmd</kbd>+<kbd>Shift</kbd>+<kbd>N</kbd>).

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/getting-started/quickstart/`.

**Files touched:**
- `docs-site/src/content/docs/getting-started/quickstart.md`

---

## Task 2: Complete Introduction & Installation Guides with Screenshots
**Description:** Enrich `getting-started/index.md` and `getting-started/installation.md` with comprehensive architectural details, protocol support matrices, and platform-specific installation workflows (macOS Gatekeeper unquarantine, Windows silent NSIS install, and Linux AppImage).

**Acceptance criteria:**
- [x] `getting-started/index.md` details clean-room design, Git-backed workspaces, and protocol support table.
- [x] Embeds `workspace-picker.png` showcasing the workspace selection dialogue.
- [x] `getting-started/installation.md` details macOS, Windows (silent enterprise fleet flags), and Linux instructions.

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/getting-started/` and `/getting-started/installation/`.

**Files touched:**
- `docs-site/src/content/docs/getting-started/index.md`
- `docs-site/src/content/docs/getting-started/installation.md`

---

## Checkpoint: Getting Started & Walkthrough
- [x] Quickstart renders all 4 live screenshots in sequence.
- [x] Introduction and Installation pages provide complete guidance.

---

## Task 3: Complete REST Client Guide with Live Screenshot
**Description:** Expand `guides/rest-client.md` with detailed explanations of Wirebench 2.0 REST features, query parameters editor, path variables (`/users/{id}`), body formats (JSON, multipart form-data, urlencoded, raw), response headers, and status code verification.

**Acceptance criteria:**
- [x] Embeds `rest-response.png` illustrating the query parameter table, URL bar, and JSON response viewer.
- [x] Details path variables resolution, headers configuration, and multipart uploads.
- [x] Uses Postman-style `<MethodBadge>` and `<Endpoint>` components.

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/guides/rest-client/`.

**Files touched:**
- `docs-site/src/content/docs/guides/rest-client.md`

---

## Task 4: Complete SOAP & WSDL Guide with Live Screenshots
**Description:** Expand `guides/soap-wsdl.md` with in-depth documentation on WSDL parsing, schema exploration, XML envelope generation, WS-Security configuration (UsernameToken, X.509 certificates, PKCS#12 and JKS keystores), and MTOM/SwA attachment handling.

**Acceptance criteria:**
- [x] Embeds `import-wsdl.png` (WSDL URL/file import modal).
- [x] Embeds `request-editor.png` (generated envelope and operations tree).
- [x] Embeds `response.png` (response body and headers viewer).
- [x] Documents WS-Security signature generation, keystore loading, and MTOM MIME packaging.

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/guides/soap-wsdl/`.

**Files touched:**
- `docs-site/src/content/docs/guides/soap-wsdl.md`

---

## Checkpoint: Core Protocol Guides
- [x] REST client guide renders `rest-response.png` and full feature documentation.
- [x] SOAP guide renders `import-wsdl.png`, `request-editor.png`, and `response.png`.

---

## Task 5: Complete Environments & Property Expansion Guide
**Description:** Expand `guides/environments.md` with complete documentation on environment management, variable scopes, property expansion syntax (`${#Env#x}`, `${#Project#x}`, `${#Workspace#x}`), precedence rules, and encrypted secrets.

**Acceptance criteria:**
- [x] Scope precedence table with real examples for URLs, headers, and request bodies.
- [x] Documents masked secrets and export protection.
- [x] Details per-variable enable/disable toggles.

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/guides/environments/`.

**Files touched:**
- `docs-site/src/content/docs/guides/environments.md`

---

## Task 6: Complete Shared Workspaces Guide with Live Screenshots
**Description:** Expand `guides/workspaces.md` with full documentation on Git-backed team workspaces, repository syncing, ahead/behind tracking, and 3-way visual conflict resolution.

**Acceptance criteria:**
- [x] Embeds `sync-panel.png` showing Git branch tracking, ahead/behind counters, and sync history.
- [x] Embeds `conflict-resolver.png` showing the 3-way visual conflict resolution tool.
- [x] Details non-destructive merging and Git remote configuration.

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/guides/workspaces/`.

**Files touched:**
- `docs-site/src/content/docs/guides/workspaces.md`

---

## Checkpoint: Environments & Workspaces
- [x] Environments guide covers all scopes and property expansion syntax.
- [x] Workspaces guide renders `sync-panel.png` and `conflict-resolver.png`.

---

## Task 7: Complete Keyboard Shortcuts & Project Format Reference
**Description:** Expand `reference/shortcuts.md` with the full matrix of keyboard shortcuts across macOS and Windows/Linux, and enrich `reference/project-format.md` with the complete filesystem specification for Wirebench version 3 projects.

**Acceptance criteria:**
- [x] `reference/shortcuts.md` documents all editor, execution, explorer, and console shortcuts with `<Shortcut>` chips.
- [x] `reference/project-format.md` documents the `.wirebench/` directory and `project.json` schema.

**Verification:**
- [x] `pnpm docs:build` passes.
- [x] Manual check at `http://localhost:4321/reference/shortcuts/` and `/reference/project-format/`.

**Files touched:**
- `docs-site/src/content/docs/reference/shortcuts.md`
- `docs-site/src/content/docs/reference/project-format.md`

---

## Task 8: Full Build, Search Indexing & Clean-Room Verification
**Description:** Run the full production build to ensure all pages compile cleanly, verify that Pagefind search indexes all content, and run `pnpm check:banned-terms` to guarantee zero proprietary competitor references exist.

**Acceptance criteria:**
- [x] `pnpm docs:build` succeeds with 0 errors.
- [x] Pagefind indexes all HTML pages.
- [x] `pnpm check:banned-terms` passes with 0 violations.
- [x] All embedded images load with HTTP 200 on `http://localhost:4321`.

**Verification:**
- [x] Automated build and test commands exit with code 0.

**Status:** Completed
