# Plan: Swagger 2.0 (OpenAPI 2.0) Import Support

Builds on `docs/specs/2026-09-14-swagger-2-import-design.md`.

## Goals

1. Extend `OpenApiVersion` to include `'2.0'`.
2. Update `versionOf` to recognize Swagger 2.0 documents (`swagger: "2.0"` or `swagger: "2.x"`) returning `{ version: '2.0', declared: 'Swagger ...' }`.
3. Implement `parseSwagger2Document` in `packages/engine/src/rest/openapi/parse.ts` to convert Swagger 2.0 documents into the internal `OpenApiDocument` representation:
   - Server URLs derived from `host`, `basePath`, and `schemes`.
   - Security schemes mapped from `securityDefinitions` (Basic, API Key, OAuth2 flows).
   - Parameters converted from primitive attributes (`type`, `format`, `items`, `enum`, `default`) into `JsonSchema`.
   - Request bodies converted from `in: "body"` parameter (`consumes` media types) and `in: "formData"` parameters (synthesized object schema with `multipart/form-data` or `application/x-www-form-urlencoded`).
   - Operation and path parameters properly merged with operation overrides.
   - Operations, tags, security requirements, and vendor extensions handled gracefully with skipped tracking.
4. Verify reference resolution (`#/definitions/...` and `#/parameters/...`) works cleanly without changes to `refs.ts`.
5. Add unit and integration tests, craft a Swagger 2.0 fixture, and update E2E test from refusal to successful import.
6. Verify all 5,000+ tests pass with `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm check:banned-terms`.

## Vertical Slices & Task Breakdown

### Slice 1: Model & Version Detection (`packages/engine`)
- **Files**:
  - `packages/engine/src/rest/openapi/model.ts`:
    - Extend `OpenApiVersion` to `'2.0' | '3.0' | '3.1' | '3.2'`.
  - `packages/engine/src/rest/openapi/parse.ts`:
    - Update `versionOf` to accept `swagger: '2.0'` or `swagger: '2.x'` and return `{ version: '2.0', declared: `Swagger ${swagger}` }`.
    - Update error message for unsupported versions to list Swagger 2.0 alongside 3.x and OpenAPI 3.x.
- **Tests**:
  - `packages/engine/test/unit/rest/openapi/parse.test.ts`:
    - Add test for `versionOf({ swagger: '2.0' })` returning `{ version: '2.0', declared: 'Swagger 2.0' }`.
    - Update/remove refusal test for Swagger 2.0.

### Slice 2: Swagger 2.0 Parsing & Conversion (`packages/engine`)
- **Files**:
  - `packages/engine/src/rest/openapi/parse.ts`:
    - Add `parseSwagger2Document(document, declared)`:
      - `parseSwagger2Servers`: compose server URLs from `host`, `basePath`, and `schemes`.
      - `parseSwagger2Operations`: iterate `paths` and HTTP methods, handling path-level and operation-level parameters.
      - Parameter handling:
        - Separate `in: 'body'`, `in: 'formData'`, and standard parameters (`in: 'path' | 'query' | 'header'`).
        - `synthesizeSwagger2ParamSchema`: build `JsonSchema` from primitive fields (`type`, `format`, `items`, `enum`, `default`).
        - Map `in: 'body'` to `OpenApiRequestBody` with schema and `consumes` media types.
        - Map `in: 'formData'` to `OpenApiRequestBody` with an object schema, mapping `type: 'file'` to `{ type: 'string', format: 'binary' }`, choosing `multipart/form-data` if file parts exist, else `application/x-www-form-urlencoded`.
      - `parseSwagger2SecuritySchemes`: map `securityDefinitions` to `OpenApiSecurityScheme[]`:
        - `type: 'basic'` -> `type: 'http', scheme: 'basic'`
        - `type: 'apiKey'` -> `type: 'apiKey', in: def.in, keyName: def.name`
        - `type: 'oauth2'` -> `type: 'oauth2'`, mapping flows (`implicit`, `password`, `application` -> `clientCredentials`, `accessCode` -> `authorizationCode`).
      - In `parseOpenApiDocument`, branch on `version === '2.0'` to call `parseSwagger2Document`.
- **Tests**:
  - `packages/engine/test/unit/rest/openapi/parse.test.ts`:
    - Test server URL composition for host/basePath/schemes variations.
    - Test body parameter mapping and sample body generation.
    - Test formData parameter mapping (urlencoded vs multipart).
    - Test security definition mapping.

### Slice 3: Fixture, Integration Tests & E2E Verification
- **Files**:
  - Create `fixtures/openapi/crafted/v20/swagger.json` or `fixtures/openapi/crafted/v20/swagger.yaml` exercising:
    - Host, basePath, schemes.
    - Path and query parameters with enums, defaults, primitive types.
    - `in: "body"` parameter with `$ref` to `#/definitions/...`.
    - `in: "formData"` parameters with file and text fields.
    - Basic auth, API key auth, OAuth2 flows in `securityDefinitions`.
  - `packages/engine/test/unit/rest/openapi/import.test.ts`:
    - Add end-to-end import test of Swagger 2.0 document.
    - Verify `RestApi`, requests, folders, parameters, sample bodies, and auth scheme candidates.
    - Update previous test expecting refusal.
  - `e2e/specs/openapi-import.spec.ts`:
    - Update line 212 test to assert successful import of Swagger 2.0 URL instead of refusal.
- **Verification**:
  - Run `pnpm --filter @wirebench/engine build`.
  - Run `pnpm vitest run packages/engine/test/unit/rest/openapi/`.
  - Run `WIREBENCH_SKIP_PERF=1 pnpm check`.
  - Run `pnpm check:banned-terms`.

---

## Verification Plan

```bash
# 1. Build engine:
pnpm --filter @wirebench/engine build

# 2. Run openapi unit and integration tests:
pnpm vitest run packages/engine/test/unit/rest/openapi/

# 3. Run desktop tests:
pnpm vitest run apps/desktop/test/renderer/import-openapi-dialog.test.tsx apps/desktop/test/ipc-api.test.ts

# 4. Run full check:
WIREBENCH_SKIP_PERF=1 pnpm check

# 5. Check banned terms:
pnpm check:banned-terms
```
