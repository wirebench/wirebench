# Wirebench: the API Overview tab — design

Date: 2026-10-24 · Status: approved · Branch `feat/general-changes` (after 993707dd9, which split the
API page into tabs).

- Builds on: the tabbed settings pages (`components/settings-page-tabs.tsx`), the REST model's
  `description` fields (Markdown, already imported for the API, its folders and its requests), the
  sync backends' `log` (`main/sync/git-backend.ts`, `server-backend.ts`).
- Owner rulings (2026-10-24, two popups):
  1. **REST API page first.** WebSocket, gRPC, MCP and the project page follow in a later change.
  2. The description is **rendered, with an Edit toggle** on the Overview itself. General keeps
     Name and Base URL only.
  3. **Recent changes come from git history for this API's files**, grouped by day; hidden with a
     short note when the project has none.
  4. **View complete documentation opens a docs tab in the app**, read-only, with HTML and
     Markdown export from there.
  5. **One spec** for the three parts (overview, change history, docs view), built in that order.
  6. Markdown is rendered with **react-markdown**, raw HTML off.
  7. **Server-synced projects show "no history"** in this change; a per-path filter on the
     server's log is a follow-up.
  8. Saved response examples in the docs tab show **status and the first lines, with Show all**;
     the export includes them in full.

## 1. Objective

An API page today opens on a form. Someone landing on an imported API — a teammate's collection,
say — cannot read what it is for: the description that came with it is squeezed into a one-line
field, folder and request descriptions are only visible one request at a time, and nothing says
how big the API is or what changed lately.

The Overview tab answers "what is this API and what has happened to it" at a glance:

- **Read** the API's description as formatted text (headings, lists, links, code).
- **See its shape**: how many requests and folders, its auth, where its definition came from, and
  which environment overrides its base URL.
- **See what changed lately**: commits that touched this API, by day, with author and message.
- **Read all of it**: one documentation tab with every folder and request, and a file to hand on.

Users: anyone opening a REST API in the desktop app, most of all someone reading an API they did
not write.

## 2. Measured state (at 993707dd9)

| Part | Where it is today | Gap |
| --- | --- | --- |
| API page | `features/rest-api/api-tab.tsx`: tabs General · Authentication · Scripts · Definition | no Overview; first tab is a form |
| Description | `RestApiWire.description?: string`; edited by a single-line `TextSetting` in General | multi-line Markdown shown as one line, never rendered |
| Folder / request descriptions | `description?: string` on the model (`protocol-rest/src/rest/model.ts`), mapped by the importers (`postman/map.ts` etc.) | no place shows them together |
| Markdown | no renderer in `apps/desktop` | new dependency |
| History | `SyncBackend.log(limit)` → `sync.log` channel; git backend runs `git log -n <limit>` on the whole tree | no per-path filter; workspace-wide only |
| On disk | each API is a folder, `projects/<slug>/apis/<api name>/` (`api.yaml`, `requests/…`) | — |
| Docs export | SOAP only: `interface-editor/generate-docs-dialog.tsx`, rendered in main | nothing for REST |

## 3. Design

### 3.1 Overview tab (REST API page)

The first tab of the REST API page, selected by default (`SettingsPageTabs` falls back to the
first tab, so no stored choice changes). Two columns at ≥ 900 px, stacked below that:

**Main column**

- The API name as the page heading (`h2`).
- The description rendered as Markdown (`MarkdownView`, §3.4). Empty: a muted line "No
  description." with an *Add description* button.
- An *Edit* button (top right of the description) swaps the rendered text for a multi-line
  `textarea` with *Save* and *Cancel*. Save sends the same `update-api` patch General used to
  (`{ description }`, `null` when emptied). Escape cancels, ⌘/Ctrl+Enter saves. A description
  rewritten under an open editor (Update definition) does not overwrite the draft; the draft wins
  until Save or Cancel.
- Under the text, a link-style button **View complete documentation →** (§3.3).

**Side column** — a summary, each line an icon and a fact:

- *N requests* · *M folders* (counted from the API's tree, folders at any depth).
- *Auth*: the API-level auth type label ("Bearer token", "None", …), a link that opens the
  Authentication tab.
- *Base URL*: the effective URL and its source, using the existing `effectiveBaseUrl`.
- *Definition*: the source (file name or URL) when imported, a link to the Definition tab.
- **Recent changes** (§3.2), collapsible, open by default.

General loses the Description field (ruling 2); its Name and Base URL stay.

### 3.2 Recent changes

**Main.** A new channel `sync.pathLog`:

```ts
// request
{ projectId: string; apiId: string; limit: number /* 1..100 */ }
// response
{ status: 'ok'; entries: SyncLogEntryWire[] }      // newest first
| { status: 'unavailable'; reason: 'no-history' | 'outside-tree' }
```

- Main resolves the API's folder from `projectId` + `apiId` itself; no path crosses the bridge.
- **Git backend**: `git log --format=… -n <limit> -- <folder relative to the tree>`, run through
  the same `GitCli` and safe-config check as `log`. `--follow` is not used (it takes one file);
  a renamed API folder therefore starts a fresh history — acceptable, and stated in the UI hint.
- **Folder backend** (no git) → `unavailable / no-history`.
- **Project outside the sync tree** (a linked project) → `unavailable / outside-tree`.
- **Server backend** → `unavailable / no-history` (ruling 7): the server's commit store records
  no changed paths yet.

**Renderer.** Entries grouped by local calendar day (heading "October 24, 2026"); each row shows
time, author and the commit subject, truncated with the full text in `title`. At most 20 entries,
then "Show more" (asks again with a higher limit, up to 100). Unavailable → one muted line: "No
history: this project is not under version control." / "…is outside the synced folder." Loaded
when the Overview tab is shown, refreshed after a commit or pull (the sync store's existing
`status` change is the trigger).

### 3.3 Documentation tab

**View complete documentation** opens an editor tab of a new kind `api-docs` (id
`api-docs:<apiId>`, title "<API name> — Docs"), one per API.

Content, read-only, top to bottom:

1. API name, rendered description, base URL, auth type.
2. A table of contents: folders and requests in tree order, each an in-page anchor.
3. Per folder: its name as a heading and its rendered description.
4. Per request: method badge and name; the URL template; its rendered description; tables for
   path, query and header parameters (name, value or example, description); the body as a code
   block when there is one; saved examples when present — status and the first 12 lines of the
   body, with *Show all* (ruling 8).

The page is built from the project store in the renderer — nothing new in main for viewing.
Variables (`${base_url}`) are shown as written, never resolved, so no secret value reaches the
page.

**Export** (buttons top right, *Export HTML…* and *Export Markdown…*): a new channel
`rest.exportDocs` `{ apiId, format: 'html' | 'markdown' }`. As with the SOAP export, main renders
the document from the project model, runs the native Save dialog and writes the file; no path
crosses the bridge. HTML is one self-contained page (inline CSS, no script). Secrets are never
resolved here either.

### 3.4 MarkdownView

`components/markdown-view.tsx`, a thin wrapper over `react-markdown` with `remark-gfm` (tables,
task lists, strikethrough):

- Raw HTML is **not** rendered (`skipHtml`), so an imported description cannot inject markup.
- Links open in the system browser through the existing external-link path, never inside the
  app window; `javascript:` and other non-http(s)/mailto URLs are dropped.
- Images are not loaded (shown as their alt text), so a description cannot make the app fetch a
  remote URL.
- Styled with the app's tokens (headings, lists, `code`, tables), dark and light.

The export renderer in main (§3.3) uses the same rules for HTML: escape raw HTML, drop unsafe
link schemes, no remote images.

## 4. Tech stack

Existing: React 19, TypeScript, Tailwind v4 tokens, zustand, zod IPC channels, the git CLI through
`GitCli`. New: `react-markdown` and `remark-gfm` (renderer); for the main-side HTML export,
`mdast-util-from-markdown` + `mdast-util-gfm` + a small HTML serialiser of our own (the same
micromark family react-markdown already brings in). Both additions go through
`pnpm licenses:third-party --check`.

## 5. Commands

```bash
WIREBENCH_SKIP_PERF=1 pnpm check          # gate before every commit
pnpm exec vitest run apps/desktop/test/renderer/api-overview  # focused unit tests
pnpm build && pnpm test:e2e -- api-overview                    # e2e (CI, or Docker locally)
pnpm dev                                   # run the app
```

## 6. Project structure

```
apps/desktop/src/renderer/components/markdown-view.tsx          MarkdownView
apps/desktop/src/renderer/features/rest-api/overview-tab.tsx    Overview tab
apps/desktop/src/renderer/features/rest-api/api-summary.tsx     side column
apps/desktop/src/renderer/features/rest-api/recent-changes.tsx  §3.2 list
apps/desktop/src/renderer/features/rest-api/api-docs-tab.tsx    §3.3 docs tab
apps/desktop/src/main/sync/path-log.ts                          per-path log
apps/desktop/src/main/ipc/rest-docs.ts                          export channel
packages/protocol-rest/src/rest/docs/                           Markdown/HTML document builder
apps/desktop/test/renderer/…, apps/desktop/test/main/…, e2e/specs/api-overview.spec.ts
docs/user/…                                                     user docs for the tab
```

## 7. Code style

As the rest of the renderer: function components, zustand selectors, `SettingsGroup` for grouped
rows, no `any`, comments say why. For example:

```tsx
export function RecentChanges({ projectId, apiId }: RecentChangesProps) {
  const history = usePathLog(projectId, apiId);
  if (history.status === 'unavailable') {
    return <p className="text-sm text-fg-subtle">{UNAVAILABLE[history.reason]}</p>;
  }
  return <ol aria-label="Recent changes">{byDay(history.entries).map(renderDay)}</ol>;
}
```

## 8. Testing strategy

- **Unit (vitest, jsdom)**: MarkdownView (raw HTML skipped, unsafe links dropped, images not
  loaded); Overview (renders description, Edit/Save/Cancel patches, empty state, counts, links to
  tabs); RecentChanges (grouping by day, unavailable reasons, Show more); docs tab (tree order,
  anchors, parameters, variables left unresolved).
- **Main (vitest)**: `pathLog` against a temporary git repo (only commits touching the API's folder,
  limit honoured, folder backend and linked project unavailable); docs builder (Markdown and HTML
  snapshots of a fixture API, HTML escaping, no remote images).
- **e2e (Playwright, CI)**: import a fixture collection with a Markdown description → Overview
  shows it rendered → Edit and save → View complete documentation opens the docs tab.

## 9. Boundaries

- **Always**: keep every secret and variable unresolved in the Overview, docs tab and export;
  resolve paths in main, never send one over the bridge; gate with `pnpm check`; one commit per
  task; describe behaviour neutrally (no product names — `pnpm check:banned-terms`).
- **Ask first**: any dependency beyond react-markdown, remark-gfm and the mdast utilities; changing
  the stored API format (none is planned — descriptions already exist); extending the Overview to
  the other API kinds or the project page (ruling 1 defers it).
- **Never**: render raw HTML from a description; fetch remote images; open links inside the app
  window; resolve `${…}` values into documentation.

## 10. Success criteria

1. Opening a REST API shows the Overview tab first, with its description rendered as Markdown.
2. Edit → change → Save updates the description through one `update-api` patch; Cancel and Escape
   leave it untouched; an emptied description is stored as absent.
3. The side column shows the right request and folder counts, auth type, effective base URL and
   definition source, and its links open the matching tabs.
4. In a git-backed project, Recent changes lists only commits that touched this API's folder,
   newest first, grouped by day; a folder-backed, server-synced or linked project shows the
   "no history" note.
5. View complete documentation opens one docs tab per API with every folder and request in tree
   order; Export writes an HTML or Markdown file through the Save dialog, examples in full.
6. A description containing `<script>`, `<img src=https://…>` or a `javascript:` link renders none
   of them, in the app or in the exported HTML.
7. `pnpm check` is green and the new e2e passes in CI.

## 11. Open questions

None; both were ruled on 2026-10-24 (rulings 7 and 8).

## 12. Follow-ups

- The Overview on the WebSocket, gRPC and MCP pages and on the project page (ruling 1).
- Per-path history for server-synced projects (ruling 7).
