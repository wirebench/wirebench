# Multi-environment send Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development.

**Goal:** One action sends a request to several environments in parallel and shows the responses side by side with the semantic diff (#35).

**Architecture:** Main resolves the request per environment (explicit `envId` threaded through the existing SOAP and REST resolution, active environment untouched) and fans out in a new `multi-env-send.ts`; the renderer adds a picker dialog and a compare tab that reuses `DiffView` / `DiffXmlEditor` and `diffHeaders`.

**Tech Stack:** TypeScript, zod, React, vitest, Playwright (Electron).

**Spec:** docs/specs/2026-09-22-multi-env-send-design.md

## Global Constraints

- Changes to `project-host.ts`, `wire-types.ts`, `ipc.ts`, `ipc/request.ts` and the REST/SOAP editors are small and additive; an absent `envId` behaves exactly as today.
- Secrets resolve in main from the keychain; the renderer only gets redacted summaries.
- Workspace mode: action disabled (spec, Non-goals).
- Gate: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check` before each commit; one commit per task; author Mohammed Naami <m.naami@outlook.com>; no Co-Authored-By / Claude-Session trailers.
- No local Electron e2e runs; CI runs e2e.
- Never name another product as inspiration (`pnpm check:banned-terms`).

---

### Task 1: Per-environment resolution in ProjectHost

**Files:**
- Modify: `apps/desktop/src/main/project-host.ts`
- Test: `apps/desktop/test/unit/main/project-host-env.test.ts` (or the nearest existing project-host test file)

**Interfaces:**
- `restSend(requestId: string, draft?: RestRequestPatchWire, envId?: string): RestSendResolution | undefined` — `envId` feeds `scopesFor(envId)` and `resolveApiBaseUrl(project, envId ?? activeEnvironmentId, api)`.
- `endpointFor(requestId: string, envId?: string): string | undefined` — wraps `resolveEndpoint`.
- `sendInputFor(requestId, overrides, envId?)` — expands with `scopesFor(envId)`.

- [ ] Tests: two environments with different base URLs/properties; explicit `envId` yields that env's URL and values; no `envId` equals today's result; `activeEnvironmentId` unchanged after the calls; unknown `envId` returns `undefined`.
- [ ] Implement; gate; commit `feat(main): resolve a request under a named environment`.

### Task 2: Wire schema and channel

**Files:**
- Modify: `apps/desktop/src/shared/wire-types.ts`, `apps/desktop/src/shared/ipc.ts`, preload typing if channels are listed there
- Test: `apps/desktop/test/unit/shared/multi-env-wire.test.ts`

**Interfaces:** `requestSendToEnvironmentsRequestSchema`, `envSendResultSchema`, `requestSendToEnvironmentsResponseSchema` (spec §Wire); channel `request.sendToEnvironments`.

- [ ] Tests: accepts 2–10 ids; rejects 1 and 11; rejects an `endpoint` field (strict); result union parses `ok` SOAP, `ok` REST and `error`.
- [ ] Implement; gate; commit `feat(wire): request.sendToEnvironments`.

### Task 3: Fan-out in main

**Files:**
- Create: `apps/desktop/src/main/multi-env-send.ts`
- Modify: `apps/desktop/src/main/ipc/request.ts` (optional `envId` on `withRequestProperties` / `sendRestRequest`; register the handler; `request.cancel` with a `batchId` aborts children)
- Test: `apps/desktop/test/unit/main/multi-env-send.test.ts`

**Interfaces:**
- `export async function sendToEnvironments(service: EngineService, deps: RequestChannelDeps, request: RequestSendToEnvironmentsRequest): Promise<RequestSendToEnvironmentsResponse>`
- Child `sendId` = `${batchId}:${envId}`; `Promise.allSettled`; results in the requested order.

- [ ] Tests (fake service/deps): each env sent with its own endpoint and scopes; one env with unresolved properties → `error` with code `rest-unresolved-properties` while others are `ok`; cancel aborts all children; unknown env id → `error` for that env only; active environment untouched; each child recorded in History with its environment name.
- [ ] Implement; gate; commit `feat(main): send one request to several environments`.

### Task 4: Picker and compare model (pure)

**Files:**
- Create: `apps/desktop/src/renderer/features/multi-env/env-picker.ts`, `env-compare.ts`
- Test: `apps/desktop/test/unit/renderer/multi-env/env-picker.test.ts`, `env-compare.test.ts`

**Interfaces:**
- `initialSelection(envs, activeId, remembered?): { ticked: string[]; baseline: string }`
- `canSend(sel): boolean` (≥ 2 ticked, baseline among them)
- `toCompareColumns(results): CompareColumn[]`
- `summarise(baseline: EnvSendResult, other: EnvSendResult): 'same' | 'body-differs' | 'status-differs' | 'failed'` — bodies normalised with the `log-compare.ts` pretty-printing.

- [ ] Tests: defaults, baseline fallback when the active env is unticked, whitespace-only JSON/XML differences are `same`, status mismatch wins over body, an error side is `failed`.
- [ ] Implement; gate; commit `feat(renderer): environment picker and compare model`.

### Task 5: Dialog, compare tab, editor buttons

**Files:**
- Create: `apps/desktop/src/renderer/features/multi-env/env-picker-dialog.tsx`, `env-compare-view.tsx`
- Modify: `apps/desktop/src/renderer/state/editors.ts` (`kind: 'env-compare'`, session only), the SOAP request editor toolbar (`features/request-editor/`), the REST editor toolbar (`features/rest-editor/`), `apps/desktop/src/shared/command-catalog.ts` + `commands.ts` (`request.sendToEnvironments`)
- Test: `apps/desktop/test/unit/renderer/multi-env/env-compare-view.test.tsx`, `env-picker-dialog.test.tsx`

- [ ] Tests (testing-library): dialog disables Send under two ticks; compare view renders one column per env with status/time, marks the baseline, shows `DiffView` for the chosen pair and the header diff rows; action disabled with < 2 environments (the workspace's inside a workspace).
- [ ] Implement; gate; commit `feat(desktop): send to environments and compare side by side`.

### Task 6: e2e

**Files:**
- Create: `e2e/specs/multi-env-send.spec.ts` (reuse the stub-server helpers in `e2e/helpers/`)

- [ ] SOAP case and REST case: project with environments *dev* and *test* pointing at two local stubs with different bodies; open picker, tick both, send; assert two columns, statuses, a diff hunk, *body differs* summary; active environment label unchanged.
- [ ] Gate (e2e runs in CI); commit `test(e2e): multi-environment send`.

### Task 7: Docs

**Files:**
- Modify: `docs-site/src/content/docs/guides/environments.mdx` (new section *Send to several environments*: picker, baseline, compare tab, History entries, workspace environments are the ones offered)

- [ ] Write the section; `pnpm check:banned-terms`; gate; commit `docs(site): send to several environments`.
