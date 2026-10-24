# Wirebench: the API Overview tab — plan

Date: 2026-10-24 · Spec: `docs/specs/2026-10-24-api-overview-tab.md` · Branch `feat/general-changes`.

One pull request, one commit per task, `WIREBENCH_SKIP_PERF=1 pnpm check` green before each commit,
`pnpm test:perf` before the push. Three phases, each ending in a checkpoint: the Overview itself
(tasks 1–3), recent changes (4–5), the documentation tab and export (6–8); then e2e and docs (9–10).
Tasks 4–5 and 6–8 depend only on phase 1 and can run in parallel sessions.

## Architecture decisions

- **MarkdownView is the one renderer** for descriptions in the app (Overview and docs tab).
  `react-markdown` + `remark-gfm`, `skipHtml`, a link component that only passes http(s)/mailto to
  the existing `window.open` → `shell.openExternal` allow-list, an image component that renders the
  alt text. Loaded inside the API page's lazy chunk, never eagerly (renderer CSP trap with eager
  imports).
- **The docs document is built once, in `protocol-rest`**, as a plain tree (`ApiDocument`) from the
  REST model, and serialised to Markdown and to safe HTML there. The renderer's docs tab renders the
  same tree with React; main's export serialises it. One builder, two outputs, one set of tests.
- **Per-path history is a new backend method**, `pathLog(relPath, limit)`, beside `log`. Only the
  git backend implements it; folder and server answer `no-history`. Main resolves the API folder
  from ids, so no path crosses the bridge.
- **Summary links reuse `useSettingsPageTabStore.select(apiId, tab)`** to jump to a tab — no new
  navigation state.

## Phase 1 — Overview

### Task 1 — MarkdownView

- Add `react-markdown` and `remark-gfm` to `apps/desktop`; run `pnpm licenses:third-party` to
  record them.
- `renderer/components/markdown-view.tsx`: `MarkdownView({ source })` per the decision above;
  token-styled headings, lists, `code`, `pre`, tables, blockquotes, links.
- Tests `test/renderer/markdown-view.test.tsx`: headings/lists/tables render; `<script>` and
  `<img>` raw HTML render nothing; `![x](https://…)` renders "x" and makes no `img`;
  `[a](javascript:alert(1))` renders text, no link; an http link has `target="_blank"` and
  `rel="noreferrer"`.

Acceptance: the safety cases above hold; light and dark both readable.
Verify: focused vitest; `pnpm licenses:third-party --check`; `pnpm build` (desktop bundle).
Files: `apps/desktop/package.json`, `pnpm-lock.yaml`, `markdown-view.tsx`, its test, the
third-party licences file.

### Task 2 — Overview tab with description edit

- `features/rest-api/overview-tab.tsx`: heading, `MarkdownView` of `api.description`, empty state
  with *Add description*, *Edit* → `textarea` + *Save*/*Cancel*; Escape cancels, ⌘/Ctrl+Enter saves;
  a store change under an open draft does not replace it. Save patches `{ description }` (`null`
  when empty). A *View complete documentation →* button that renders only when an `onOpenDocs`
  prop is given (wired in task 7).
- `api-tab.tsx`: Overview becomes the first tab; Description leaves General.
- Tests: new `overview-tab.test.tsx` (render, empty state, Save/Cancel/Escape/⌘Enter, emptied →
  `null`, draft survives a store rewrite); `api-tab.test.tsx` description cases move here, General
  ones open `General` explicitly.

Acceptance: spec criteria 1 and 2.
Verify: focused vitest; dev app — open an imported REST API, see the rendered description.
Files: `overview-tab.tsx`, `api-tab.tsx`, `overview-tab.test.tsx`, `api-tab.test.tsx`.

### Task 3 — summary column

- `features/rest-api/api-summary.tsx`: request and folder counts (folders at any depth, from
  `folders`/`restRequests` by `apiId`); auth type label (reuse the auth-type labels `AuthFields`
  shows); effective base URL and its source (`effectiveBaseUrl`); definition source; Auth and
  Definition lines are buttons that call `select(apiId, 'auth' | 'definition')`. A slot below for
  Recent changes (filled in task 5).
- `overview-tab.tsx`: two columns at ≥ 900 px (container query), stacked below.
- Tests `api-summary.test.tsx`: counts on a nested fixture, labels, base URL override text, the
  links switch tabs, no Definition line for a hand-made API.

Acceptance: spec criterion 3.
Verify: focused vitest; dev app at a narrow and a wide window.
Files: `api-summary.tsx`, `overview-tab.tsx`, `api-summary.test.tsx`.

### Checkpoint — Overview

- [ ] `pnpm check` green; Overview visible first on a REST API in the dev app.
- [ ] Owner looks at the tab before phase 2 starts.

## Phase 2 — Recent changes

### Task 4 — `pathLog` in main

- `main/sync/backend.ts`: `pathLog(relPath: string, limit: number): Promise<PathLogResult>` on
  `SyncBackend`; `PathLogResult = { status: 'ok', entries } | { status: 'unavailable', reason }`.
- `git-backend.ts`: `git log --format=%H%x00%s%x00%an%x00%aI -n <limit> -- <relPath>` through the
  existing `GitCli` (safe-config check already done at open); same entry parsing as `log`.
- `folder-backend.ts`, `server-backend.ts`: `unavailable / no-history`.
- `sync-service.ts`: `pathLogForApi(projectId, apiId, limit)` resolves the API's folder, answers
  `outside-tree` when the project dir is not inside the tree, refuses a relative path with `..`.
- Tests `test/main/sync-path-log.test.ts` on a temp git repo: two APIs, commits to each → each
  sees only its own; limit honoured; folder backend and an outside project are unavailable.

Acceptance: spec criterion 4 (main side).
Verify: focused vitest (`test/main`).
Files: `backend.ts`, `git-backend.ts`, `folder-backend.ts`, `server-backend.ts`,
`sync-service.ts` (+ the test).

### Task 5 — `sync.pathLog` channel and the Recent changes list

- `shared/wire-base.ts` schemas; `shared/ipc.ts` `sync.pathLog`; handler in `main/ipc/sync.ts`;
  the preload follows the channel table.
- `features/rest-api/recent-changes.tsx`: load on mount, refresh when the sync store's status
  changes; group by local day; 20 then *Show more* (limit 100); unavailable notes per reason;
  collapsible, open by default. Mounted in the summary slot.
- Tests `recent-changes.test.tsx`: grouping across midnight in the local zone, Show more asks with
  a higher limit, each unavailable reason's text, refresh on status change.

Acceptance: spec criterion 4 (whole).
Verify: focused vitest; dev app in a git-synced workspace — commit a change to one API, its
Overview lists it, another API's does not.
Files: `wire-base.ts`, `ipc.ts`, `main/ipc/sync.ts`, `recent-changes.tsx`, its test.

### Checkpoint — Recent changes

- [ ] `pnpm check` green; manual check above done.

## Phase 3 — Documentation

### Task 6 — document builder (protocol-rest)

- `packages/protocol-rest/src/rest/docs/document.ts`: `buildApiDocument(api, folders, requests)`
  → `ApiDocument` (API head; entries in tree order; per request method, name, URL template,
  description, path/query/header params, body text and type, examples with status and body).
  Variables left as written.
- `docs/markdown.ts` and `docs/html.ts`: serialisers. HTML is one self-contained page with inline
  CSS and no script; descriptions go through `mdast-util-from-markdown` + `mdast-util-gfm` and a
  small walker that escapes text, drops raw HTML and images (alt text kept) and unsafe link
  schemes. Examples in full in both.
- Export from the package's `rest` subpath; `pnpm check:engine-layers` stays green.
- Tests: snapshots of a fixture API (nested folders, params, a body, an example) in both formats;
  the three unsafe cases from the spec produce no tag, no remote URL, no `javascript:`.

Acceptance: spec criterion 6 (export side); deterministic output.
Verify: focused vitest in `packages/protocol-rest`; `pnpm check:engine-layers`;
`pnpm licenses:third-party --check`.
Files: `document.ts`, `markdown.ts`, `html.ts`, the package's `package.json`, the test.

### Task 7 — the docs tab

- New editor kind `api-docs` in `renderer/kinds/rest/index.tsx` (id `api-docs:<apiId>`, title
  "<name> — Docs", lazy component); `features/rest-api/api-docs-tab.tsx` renders `ApiDocument`
  with `MarkdownView` for descriptions: head, table of contents with in-page anchors, folders,
  requests; examples show status and the first 12 body lines with *Show all*.
- `overview-tab.tsx` passes `onOpenDocs` → opens the tab (one per API, reused).
- Tests `api-docs-tab.test.tsx`: tree order, anchor targets exist, params tables, Show all,
  `${base_url}` shown literally; opening twice keeps one tab.

Acceptance: spec criterion 5 (view side).
Verify: focused vitest; dev app — View complete documentation on an imported API.
Files: `kinds/rest/index.tsx`, `api-docs-tab.tsx`, `overview-tab.tsx`, the test.

### Task 8 — export

- `shared/ipc.ts` + `wire-base.ts`: `rest.exportDocs { apiId, format }` →
  `{ status: 'saved' } | { status: 'cancelled' }`.
- `main/ipc/rest-docs.ts`: build the document from the loaded project, serialise, native Save
  dialog (default name `<api name>.html|.md`), write. Mind the main-bundle string trap: no string
  literal ending in "import".
- `api-docs-tab.tsx`: *Export HTML…* / *Export Markdown…* buttons, toast on save.
- Tests: `test/main/rest-docs-export.test.ts` (dialog mocked: writes the serialised text, cancel
  writes nothing, unknown API refused); renderer button test.

Acceptance: spec criterion 5 (export side).
Verify: focused vitest; `pnpm build` then open the desktop build once (the main-bundle trap only
shows there); export both formats from the dev app and open the HTML in a browser.
Files: `ipc.ts`, `wire-base.ts`, `main/ipc/rest-docs.ts`, `api-docs-tab.tsx`, the tests.

### Checkpoint — Documentation

- [ ] `pnpm check` green; both exports open cleanly; owner reviews the docs tab.

## Phase 4 — e2e and docs

### Task 9 — e2e

- Fixture collection with a Markdown description, a nested folder and a request with a
  description. `e2e/specs/api-overview.spec.ts`: import → Overview shows a rendered heading and
  list → Edit, change, Save → reopen shows it → View complete documentation opens the docs tab
  with the folder and request.
- Existing specs that opened the API page expecting General first: `e2e/helpers/rest.ts`
  `createApi` and any spec reading `api-name`/`api-base-url` open `General` first.

Acceptance: the spec passes in CI; no other e2e regresses.
Verify: `pnpm build && pnpm test:e2e -- api-overview` in Docker or CI (no local Electron windows).
Files: the spec, the fixture, `e2e/helpers/rest.ts`, specs that read General fields.

### Task 10 — user docs and changelog

- `docs/user/…` REST page: the Overview, editing the description, recent changes (and when they
  are absent), the docs tab and export. `CHANGELOG.md` `[Unreleased]` → Added.
- `pnpm check:banned-terms`, `check:doc-paths`, `check:docs-images` green.

Acceptance: docs describe what shipped; checks green.
Verify: `pnpm check`.
Files: the user doc page, `CHANGELOG.md`.

### Checkpoint — Complete

- [ ] Spec success criteria 1–7 met; `pnpm check` and `pnpm test:perf` green; e2e green in CI.
- [ ] Ready for the owner's review before the push.

## Risks and mitigations

| Risk | Impact | Mitigation |
| --- | --- | --- |
| react-markdown (ESM, unified) breaks the renderer CSP or eager-import probe | High | import only inside the lazy API chunk; dev app + `pnpm build` check in task 1 |
| New dependencies fail the licence gate | Med | run `pnpm licenses:third-party` in tasks 1 and 6 before committing |
| Main bundle truncation by a string ending in "import" | Med | task 8 verifies with a desktop build, not only `pnpm check` |
| Unsafe Markdown slips through one of the two renderers | High | same three hostile cases tested on both (tasks 1 and 6) |
| `git log -- <path>` on a big repo is slow | Low | limit ≤ 100, run on tab show only, cached until status changes |
| Moving Description out of General breaks e2e helpers | Med | task 9 sweeps the helpers; CI e2e before merge |

## Open questions

None — the spec's two were ruled on 2026-10-24.
