# REST response validation Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development. Steps use `- [ ]`.

**Goal:** Check every JSON response of an OpenAPI-linked REST request against its declared response schema and show the result as a chip, editor markers and Problems rows.

**Architecture:** Engine keeps operation responses and a request↔operation link, a pure `checkRestResponse` and a pure JSON-Pointer→range mapper; main derives responses from the definition cache, runs the check in a deadline-bounded worker after each send, and puts the result on the exchange summary and History; the renderer draws it.

**Tech Stack:** TypeScript, zod, vitest, React, Monaco, node:worker_threads.

**Spec:** docs/specs/2026-09-22-rest-response-validation-design.md

## Global Constraints

- No new dependency; no project format version bump; new persisted fields optional and omitted when unset (byte-identical saves).
- Check runs off the main thread: worker, 1000 ms hard per-check deadline, terminate + replace on overrun → `not-checked`; bodies over 1 MiB → `skipped`.
- Problems capped at 50, messages at 300 chars; bodies never copied into results.
- Gate before every commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`; `pnpm test:perf` unskipped before push.
- One commit per task; author Mohammed Naami <m.naami@outlook.com>; NO Co-Authored-By / Claude-Session trailers.
- Never name another product (`pnpm check:banned-terms`). No local Electron e2e. Don't edit `eslint.config.js`.
- TDD: failing test first.

---

### Task 1: Operation responses in the OpenAPI model

**Files:** `packages/engine/src/rest/openapi/{model,parse}.ts`; new `packages/engine/src/rest/openapi/responses.ts`; tests `packages/engine/test/unit/rest/openapi/responses.test.ts` (+ parse tests).

**Produces:**
- `OpenApiOperation.responses?: OpenApiResponses` where `OpenApiResponses = Readonly<Record<string /* '200' | '4XX' | 'default' */, { description?: string; content?: Readonly<Record<string /* media type */, { schema?: unknown /* $ref-resolved */ }>> }>>`.
- `selectResponse(responses, status: number, contentType: string | undefined): { kind: 'schema'; responseKey: string; mediaType: string; schema: unknown } | { kind: 'no-body'; responseKey: string } | { kind: 'no-schema'; responseKey: string } | { kind: 'unmatched' }` — rules exactly as the spec's "Response selection".

- [ ] Remove the `responses` entries from the parser's skipped list; keep them on the operation (resolved via the existing `resolveRefs` output). Swagger 2.0 input, if the parser supports it: map `responses[k].schema` to `content['application/json'].schema`.
- [ ] Tests: exact status beats range beats default; `4xx` lowercase key; media type exact / `+json` / `application/*` / `*/*`; parameters ignored (`application/json; charset=utf-8`); `204` with no content → `no-body`; undeclared → `unmatched`; declared status with content but no schema → `no-schema`.
- [ ] Existing import tests that asserted `responses` were skipped are updated to the new truth.

### Task 2: Request ↔ operation link

**Files:** `packages/engine/src/rest/model.ts`, the REST request file zod schema + load/serialize in `packages/engine/src/project/*`, `packages/engine/src/rest/openapi/map.ts`; new `packages/engine/src/rest/openapi/match.ts`; tests.

**Produces:**
- `RestRequestDef.contract?: { method: string; path: string }` (path as in the document, e.g. `/pets/{petId}`); persisted, omitted when unset.
- `matchOperation(operations: readonly {method: string; path: string}[], method: string, url: string, baseUrls: readonly string[]): {method; path} | undefined` — strips a matching base URL (after `{{var}}` expansion is NOT available: treat `{{…}}` in the URL as an opaque segment/prefix), compares segment by segment, `{x}` and `{{x}}` segments match anything, literal segments must equal; exactly one match or undefined.

- [ ] Import sets `contract` on each generated request.
- [ ] Round-trip test; byte-identical save test for a request without `contract`; matcher tests (literal vs param segments, trailing slash, query string ignored, ambiguous → undefined, base URL with `{{baseUrl}}` prefix).

### Task 3: Pure check and pointer ranges

**Files:** new `packages/engine/src/rest/contract-check.ts`, new `packages/engine/src/json/pointer-range.ts` (exported from the `/json` browser-safe subpath too), tests.

**Produces:**
- `RestContractResult` exactly as the spec.
- `checkRestResponse(input: { status: number; contentType?: string; bodyText: string; language: string; streamed: boolean; operation?: {method; path}; responses?: OpenApiResponses }, options?: { budgetMs?: number; now?: () => number }): RestContractResult` — pure, synchronous, plain data in/out. Applies spec rules: not json or streamed → `skipped` (callers may choose not to call); size > 1 MiB → `skipped`; no operation/responses → `no-contract`; selection per Task 1; JSON parse failure → violation at `''`; validation via `validateJsonSchema` with a `writeOnly` pass (a present property whose schema has `writeOnly: true` → problem keyword `writeOnly`); `format` and other unsupported keywords → one note each; budget exceeded → `not-checked`.
- `pointerRange(text: string, pointer: string): { line: number; column: number; endLine: number; endColumn: number } | undefined` (1-based, Monaco style) — locates the value (for a missing required property, the parent object's opening brace), works on minified and pretty text, handles escaped keys (`~0`, `~1`) and array indices; linear time, no dependency.

- [ ] Tests for every status of the result, writeOnly, notes, caps (51 problems → 50; long message truncated), parse failure, pointer ranges on pretty and minified bodies, escaped keys, arrays, unlocatable pointer → undefined.

### Task 4: Worker with a deadline

**Files:** new `packages/engine/src/rest/contract-check-worker.ts` and `contract-check-worker-host.ts` (mirror `asyncapi/frame-check-worker{,-host}.ts`; extract shared plumbing only if it stays small), engine index exports, tests.

**Produces:** `createRestContractChecker(options?: { deadlineMs?: number; workerUrl?: URL }): { check(input): Promise<RestContractResult>; dispose(): void }` — one job at a time, queue capped at 16 jobs (overflow → `not-checked`), deadline default 1000 ms, terminate + replace on overrun, `not-checked` result; `dispose` resolves pending jobs as `not-checked`; unref'd worker.

- [ ] Tests: normal check; hanging check (test-only slow hook, as in the frame-check tests) → `not-checked` and next job succeeds; queue overflow; dispose. Deadlines in tests ≥ 600 ms (CI load).

### Task 5: Main — derive, check after send, wire, History

**Files:** `apps/desktop/src/main/project-host.ts` (responses memo per REST API from the definition cache: on open, import, definition refresh; cleared on close), `apps/desktop/src/main/engine-service.ts` or `ipc/request.ts` (after a REST send completes, if eligible, check and attach), `apps/desktop/src/shared/wire-types.ts` (`restContractResultSchema`, `RestExchangeSummary.contract?`), `apps/desktop/src/main/engine-wire.ts`, `packages/engine/src/project/history.ts` (`HistoryEntry.contract?` zod + caps), `apps/desktop/src/main/history-service.ts`; tests.

- [ ] One checker per app (created lazily, disposed on quit and workspace close).
- [ ] The check does not delay the send result more than the deadline; if it is still pending when the summary is returned, return without it and send a follow-up `rest.live` event `{ kind: 'contract', sendId, result }` — or simply await (≤ 1000 ms). Rule: **await**, it is bounded; document it.
- [ ] zod schema test proving `contract` survives the wire parse; History round-trip and cap tests; a test that an unlinked request on an API without a cache gets no `contract`; a test that a failing cache read is logged once and yields `no-contract`.

### Task 6: Renderer — chip, markers, Problems

**Files:** `apps/desktop/src/renderer/features/rest-editor/response/{status-line,body-view,response-pane}.tsx`, `apps/desktop/src/renderer/editor/markers.ts` (a second owner `wirebench-contract`, or reuse with an owner parameter), the problems store wiring (mirror `validate-actions.ts`, direction `response`, source `openapi`), `apps/desktop/src/renderer/features/history/history-entry-view.tsx`; `scripts/contrast-check.ts` for any new colour pairs; tests.

- [ ] Chip text: `Contract ✓` / `Contract: N problem(s)` / `Unexpected status` / `No schema` / `Not checked` / `Skipped`; hidden for `no-contract`; tooltip names `METHOD path → responseKey (mediaType)` and lists notes. Not colour-only (icon + text), passes contrast.
- [ ] Markers are placed with `pointerRange` against the text actually shown (pretty-printed when auto-format is on); re-placed when the view text changes; cleared on a new send.
- [ ] Problems rows reveal the marker (switch to the body view first).
- [ ] Tests for each chip state, marker placement on pretty and raw views, Problems reveal, History chip.

### Task 7: e2e, docs, perf

**Files:** `e2e/specs/rest-response-validation.spec.ts` (local REST test server + an OpenAPI fixture served locally; one clean 200, one 200 missing a required field → marker and Problems row, one undeclared 503 → `Unexpected status`), docs-site REST guide section "Response checks" (truthful to code: statuses, 1 MiB, 1000 ms, not-checked, what is skipped), `packages/engine/test/perf/rest-contract-check.perf.test.ts` (SC-7).

- [ ] Don't run e2e locally (CI runs it); `pnpm typecheck` must pass.
- [ ] Docs name no other product.
