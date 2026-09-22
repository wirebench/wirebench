# REST Update Definition Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Re-import a changed OpenAPI document into an existing REST API, preview a per-operation report, and apply it without losing user edits or deleting anything.

**Architecture:** Two pure engine functions (`planRestUpdate`, `applyRestUpdate`) that re-map the old cached and new documents with the importer's `apiFromDocument` and let a generated field follow only while it equals the old generated value; main wires them behind a fingerprint-guarded preview/apply IPC pair that rewrites the cache, drops #45's parsed-document memo and saves with rollback; the renderer adds a dialog mirroring the AsyncAPI update dialog.

**Tech Stack:** TypeScript, zod, vitest, React.

**Spec:** docs/specs/2026-09-22-rest-update-definition-design.md

## Global Constraints

- Never delete a request, folder or parameter row the user added; removed operations → `orphaned: true`, returning → flag removed (omitted, not `false`).
- A generated field follows the new document only while it equals what the OLD document generates (re-mapped with the same options as import).
- Operation identity = `method` (lowercase) + `path` as written (`RestRequestDef.contract`); requests without `contract` are untouched.
- No new dependency; no project format version bump; new persisted fields optional and omitted when unset.
- Mirror `packages/engine/src/asyncapi/update.ts`, `apps/desktop/src/main/ipc/api.ts` (`fingerprintOf`, `definition-changed`), `apps/desktop/src/renderer/features/ws-api/asyncapi-update-dialog.tsx`.
- Gate before every commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`; `pnpm test:perf` before push.
- One commit per task; author Mohammed Naami <m.naami@outlook.com>; NO Co-Authored-By / Claude-Session trailers.
- Never name another product (`pnpm check:banned-terms`). No local Electron e2e. Don't edit `eslint.config.js`. TDD.

---

### Task 1: Plan (engine, pure)

**Files:** new `packages/engine/src/rest/openapi/update.ts` (plan half), export from `packages/engine/src/index.ts`; test `packages/engine/test/unit/rest/openapi/update-plan.test.ts`; fixtures `packages/engine/test/fixtures/openapi/petstore-update-{old,next}.yaml` (small: a changed parameter, a changed request body schema, a changed response, a removed operation, an added operation with a tag, a changed server URL, a bumped `info.version`).

**Produces:**
- `RestOpRef = { method: string; path: string; summary?: string }`
- `RestChangeReason = 'parameters' | 'request-body' | 'responses' | 'security' | 'servers'`
- `RestApiChangeReason = 'servers' | 'security' | 'version'`
- `RestUpdatePlan = { added: RestOpRef[]; removed: RestOpRef[]; changed: { op: RestOpRef; reasons: RestChangeReason[] }[]; api: RestApiChangeReason[] }`
- `planRestUpdate(old: OpenApiDocument, next: OpenApiDocument): RestUpdatePlan` — identity by lowercase method + path; reasons by comparing resolved structures with a cycle-safe structural equality (schemas may be shared/cyclic — never `JSON.stringify` them; write/reuse a `sameStructure(a, b)` with a visited-pair set). Order: document order of `next` for added/changed, of `old` for removed.

- [ ] Tests: each reason in isolation; renamed path = removed + added; unchanged doc → all empty; cyclic schema in both → no throw, no false change.

### Task 2: Apply (engine, pure)

**Files:** `packages/engine/src/rest/openapi/update.ts` (apply half); test `update-apply.test.ts`.

**Produces:**
- `RestApplyResult = { api: RestApi; requestsAdded: number; requestsOrphaned: number; requestsRestored: number; requestsRewritten: number; rowsAdded: number; rowsRemoved: number }`
- `applyRestUpdate(api: RestApi, old: OpenApiDocument, next: OpenApiDocument, options?: { newId?: IdGenerator }): RestApplyResult` — pure, returns a new `RestApi`.

Rules (spec decision 5):
- Re-map both documents with `apiFromDocument(doc, sameOptionsAsImport)`; index generated requests by `contract` key.
- For each existing request with `contract`:
  - operation gone in `next` → `orphaned: true`; present and was orphaned → flag removed;
  - `url`: follow if equal to old-generated url;
  - parameter rows (path, query, headers), keyed by `in + name` (case-insensitive for headers): a row equal (value AND enabled) to its old-generated row follows the new-generated row; a new generated row is appended; a row the new doc dropped is removed only if still equal to its old-generated row; rows with no old-generated counterpart are the user's and untouched;
  - body (mode, content type, text/fields): follows only if the whole body equals the old-generated body;
  - auth: follows only if equal to the old-generated auth (including both absent).
- New operations (in next, no request with that contract) → one request each, placed in the folder named by the importer's `folderNameOf` (find by name at API root, create if missing, slug unique) or the API root.
- API level: `baseUrl`, `servers`, `auth` follow while equal to the old-mapped values; `definition.version` = next's `info.version`.
- Never delete requests or folders; counts in the result match the changes made.

- [ ] Tests: SC-1…SC-4 from the spec (untouched follows; edited kept; user rows kept; orphan/restore; new op in tag folder, folder created once for two new ops); API-level follow vs edited; plan/apply agreement (every `added` op gets a request, every `removed` op's requests orphaned).

### Task 3: Main + IPC

**Files:** `apps/desktop/src/main/project-host.ts` (`planRestUpdate(apiId, source?)`, `applyRestUpdate(apiId, source?, fingerprint)`), `apps/desktop/src/main/ipc/api.ts` (channels `api.restPlanUpdate`, `api.restApplyUpdate`, reuse `fingerprintOf` and `checkedImportSource`), `apps/desktop/src/shared/{ipc,wire-types}.ts` (zod request/response schemas), preload exposure if the pattern needs it; tests `apps/desktop/test/ipc-rest-update.test.ts`.

- [ ] Plan reads the old document from the API's definition cache (the #45 `openApiDocumentFor`), the new one from `source` (default: the API's `definition.source`; a user-chosen file/URL passes the same path-access check as import); returns `{...plan, fingerprint}`.
- [ ] Apply re-reads the source, refuses with `definition-changed` if the fingerprint differs; applies; rewrites the definition cache when `definition.cache` is true (and updates `definition.source` if a new source was chosen); `this.openApiDocuments.delete(apiId)`; saves with reason `update-definition`; if the save throws, restore the previous `open.project`/dirty state (WSDL rule) and rethrow.
- [ ] No cached old document → plan refuses with a clear error code `definition-not-cached` (the user can re-import instead).
- [ ] Tests: plan/apply happy path; fingerprint mismatch refused and nothing applied; path outside projects refused; memo dropped so a #45 check after apply uses the new response schema; save failure rolls back; no-cache refusal.

### Task 4: Renderer — dialog and entry points

**Files:** new `apps/desktop/src/renderer/features/rest-api/rest-update-dialog.tsx` (or the folder REST API overview lives in — grep), REST API context menu + overview button + command registration (mirror how the AsyncAPI "Update Definition…" entry is registered), orphaned badge for REST requests in the explorer if not already rendered (check `tree-nodes.ts`); tests.

- [ ] Dialog mirrors `asyncapi-update-dialog.tsx`: loading, empty ("already matches its source"), Added / Removed / Changed lists (label `METHOD path`, reasons joined), API-level changes line, Apply, `definition-changed` → stale state with "Preview again", optional "Choose another file or URL…", toast with counts, mounted guard.
- [ ] Entry points enabled only when the API has `definition`.
- [ ] Tests for each dialog state, entry-point enablement, orphaned badge.

### Task 5: e2e, docs

**Files:** `e2e/specs/rest-update-definition.spec.ts` (local REST test server serving the old then the new document; import, edit one parameter, update, verify: edited value kept, untouched followed, removed op's request badged orphaned, new op's request in its folder), docs-site REST guide section "Update Definition" (truthful to code), `docs/specs/2026-09-13-wirebench-rest-client-design.md` line ~276 and §15 item 7 marked shipped, roadmap line ~329 updated.

- [ ] Don't run e2e locally; `pnpm typecheck` passes. Docs name no other product.
