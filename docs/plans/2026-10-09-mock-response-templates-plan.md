# Plan: Mock response templates

Spec: [`docs/specs/2026-10-09-mock-response-templates-design.md`](../specs/2026-10-09-mock-response-templates-design.md)
Issue: [#323](https://github.com/wirebench/wirebench/issues/323)

**Goal:** a response with `values` echoes request values into its body and headers, escaped for where they
land; everything else is still sent byte for byte.

Each task ends with `WIREBENCH_SKIP_PERF=1 pnpm check` green and one commit.

## Task 1: Spec, ADR-0022, plan

- [x] This file, the spec and the ADR.

## Task 2: File format and model

- `model.ts`: `MockTemplateValue` (a match source without checks), `MockResponse.values?`,
  `MOCK_VERSION = 2`, `MOCK_LIMITS.valuesPerResponse = 20`, `TEMPLATE_NAME_PATTERN`.
- `file.ts`: `values` in `responseFileSchema`; `version` 1 or 2 in `mockFileSchema`; `mockDocument` writes 2
  only when a response has values; `responseDocument` writes `values`.
- `load.ts` / `validateMock`: refuse `values` under version 1; refuse undeclared placeholders and JSON
  placeholders outside strings (`template.ts` `checkTemplate`).
- `pnpm schemas:project` regenerated.
- Tests: `test/unit/mock/file.test.ts` and `load.test.ts` cases from the spec.

## Task 3: Rendering

- `template.ts`: `renderResponse(response, request, view)` → `{ ok, headers, bodyText } | { ok: false, … }`;
  one-pass substitution, XML/JSON escaping, header check with `validateHeaderValue`.
- `dispatch.ts`: export the value reader for reuse.
- `server.ts`: render after dispatch; failure → `contract.fail('mock-template-refused', …)`.
- Tests: `test/unit/mock/template.test.ts` (hostile values), server test for echo and refusal.

## Task 4: Docs and changelog

- Guide `mock-services.mdx` section "Echoing request values"; `project-format.md` version note.
- `CHANGELOG.md` under [Unreleased].
