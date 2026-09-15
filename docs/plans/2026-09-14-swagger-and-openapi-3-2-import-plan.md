# Plan: Swagger 3.x and OpenAPI 3.2 Import Support

Builds on `docs/specs/2026-09-14-swagger-and-openapi-3-2-import-design.md`.

## Goals

1. Support importing OpenAPI 3.2.x documents (`openapi: 3.2.0`, `openapi: 3.2.x`).
2. Support importing documents declaring Swagger 3.x (`swagger: 3.0.x`, `swagger: 3.1.x`, `swagger: 3.2.0`).
3. Support OpenAPI 3.2 `additionalOperations` on Path Item objects.
4. Support OpenAPI 3.2 Example Object `dataValue` and `serializedValue`.
5. Maintain clear, helpful refusal for Swagger 2.0 (`swagger: 2.0`) with updated supported versions list.
6. Verify via comprehensive unit, integration, and quality-gate tests with 0 regressions.

## Vertical Slices & Task Breakdown

### Slice 1: Version Model & Detection (`packages/engine`)
- **Files**:
  - `packages/engine/src/rest/openapi/model.ts`: Extend `OpenApiVersion` to `'3.0' | '3.1' | '3.2'`.
  - `packages/engine/src/rest/openapi/parse.ts`:
    - Update `versionOf` to accept `openapi: 3.2.x` and `swagger: 3.0.x`, `3.1.x`, `3.2.x`.
    - Map `swagger: 3.x` to respective `version` and preserve the declared version string.
    - Update the Swagger 2.0 refusal message to cite OpenAPI 3.0, 3.1, and 3.2.
- **Tests**:
  - `packages/engine/test/unit/rest/openapi/parse.test.ts`:
    - Add tests for `openapi: '3.2.0'` and `openapi: '3.2.1'`.
    - Add tests for `swagger: '3.0.0'`, `swagger: '3.0.3'`, `swagger: '3.1.0'`, `swagger: '3.2.0'`.
    - Update and verify Swagger 2.0 rejection test.

### Slice 2: OpenAPI 3.2 Additions (`packages/engine`)
- **Files**:
  - `packages/engine/src/rest/openapi/model.ts`:
    - Update `OpenApiExample` to include `dataValue` and `serializedValue`.
  - `packages/engine/src/rest/openapi/parse.ts`:
    - In `parseOperations`, read `item['additionalOperations']` and parse operations with non-standard methods (e.g. `QUERY`).
    - In `parseExamples`, read `example['value'] ?? example['dataValue'] ?? example['serializedValue']`.
    - In `parseRequestBody`, support media types specifying `itemSchema` when `schema` is absent.
- **Tests**:
  - Add crafted fixture `fixtures/openapi/crafted/v32/openapi.yaml` with OpenAPI 3.2 features (`additionalOperations` with `QUERY`, `dataValue`, `itemSchema`).
  - Add test suite in `packages/engine/test/unit/rest/openapi/parse.test.ts` for OpenAPI 3.2 features.

### Slice 3: End-to-End Import & Desktop Integration
- **Files**:
  - `packages/engine/test/unit/rest/openapi/import.test.ts`:
    - Test end-to-end import of OpenAPI 3.2 and Swagger 3.0 documents.
  - `apps/desktop/test/renderer/import-openapi-dialog.test.tsx` & `apps/desktop/test/ipc-api.test.ts`:
    - Verify dialog display and IPC handling of OpenAPI 3.2 and Swagger 3.x summaries.
- **Verification**:
  - Run full test suite: `pnpm check`.

---

## Verification Plan

```bash
# 1. Run openapi unit tests:
pnpm vitest run packages/engine/test/unit/rest/openapi/

# 2. Run desktop tests:
pnpm vitest run apps/desktop/test/renderer/import-openapi-dialog.test.tsx apps/desktop/test/ipc-api.test.ts

# 3. Run full verification gate:
WIREBENCH_SKIP_PERF=1 pnpm check

# 4. Check banned terms:
pnpm check:banned-terms
```
