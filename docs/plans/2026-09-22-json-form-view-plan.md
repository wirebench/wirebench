# JSON form view — plan

Spec: `docs/specs/2026-09-22-json-form-view-design.md`. Issue #46.

## Global constraints

- Gate before each commit: `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
- One commit per task, as Mohammed Naami <m.naami@outlook.com>. No Co-Authored-By or Claude-Session trailer.
- Never name another product as inspiration; `pnpm check:banned-terms` enforces it.
- Do not touch `packages/engine/src/rest/openapi/update.ts`; changes to `project-host.ts`, `ipc.ts`,
  `wire-types.ts` are additive.
- No local Electron e2e runs; CI runs e2e.
- Renderer imports engine code only through the `@wirebench/engine/rest` subpath.

## Task 1 — engine form model

Files: `packages/engine/src/rest/json-form.ts` (new), `packages/engine/src/rest/browser.ts`,
`packages/engine/src/index.ts`, `packages/engine/test/unit/rest/json-form.test.ts` (new).

Interfaces: `JsonFormNode`, `JsonFormKind`, `JsonFormValueType`, `JsonFormEdit`, `buildJsonForm`,
`applyJsonFormEdit`, `toWireSchema`, exactly as in the spec's Model section.

Tests: object with required + optional properties (present flags, labels from `title`); array of
objects; enum field; integer vs number; `allOf` merge; `oneOf` chosen by required keys; cyclic schema
cut at depth to `any`; unknown property preserved as `any` and kept by edits; every edit kind;
`insert-optional` value equals `sampleFromSchema`; `toWireSchema` output survives `structuredClone`
and `JSON.stringify` for a cyclic input.

## Task 2 — body schema over IPC

Files: `apps/desktop/src/main/project-host.ts` (add `restBodySchema`), `project-router.ts`,
`workspace-service.ts` (proxy), `apps/desktop/src/shared/ipc.ts` (`request.restBodySchema`),
`apps/desktop/src/shared/wire-types.ts` (request/response zod schemas), handler in
`apps/desktop/src/main/ipc/request.ts`, tests in `apps/desktop/test/` next to the existing
`restContractFor` / ipc-request tests.

Interface: `restBodySchema(requestId: string): Promise<{ mediaType: string; schema: JsonSchema } | undefined>`;
channel response `{ mediaType, schema } | null`, schema passed through `toWireSchema`.

Tests: linked contract → schema; URL match without link → schema; operation with only XML body → null;
API without cached definition → null; `application/vnd.x+json` accepted.

## Task 3 — Form view in the body tab

Files: `apps/desktop/src/renderer/features/rest-editor/json-form-view.tsx` (new),
`.../rest-editor/body-tab.tsx`, `apps/desktop/src/renderer/state/editors.ts` (per-request
`'text' | 'form'`), `apps/desktop/test/renderer/rest-json-form-view.test.tsx` (new).

Interface: `JsonFormView({ text, schema, onChange, readOnly? })`; `BodyTab` fetches the schema via
`request.restBodySchema` (injectable source for tests) and shows the Text/Form switch per the spec.

Tests: field edit updates body text; insert/remove optional; add/remove array item; enum select;
choice switch; invalid JSON shows the message and a way back to Text; switch hidden when the schema is
null or the language is not JSON; Text → Form → Text leaves text unchanged.

## Task 4 — e2e and docs

Files: `e2e/specs/rest-json-form.spec.ts` (new, with a small OpenAPI fixture following existing REST
e2e fixtures), `docs-site/src/content/docs/guides/rest-client.mdx` ("Request body" section).

Tests: e2e as in the spec (CI only; typecheck/lint locally).
