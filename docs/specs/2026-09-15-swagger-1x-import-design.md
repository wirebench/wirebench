# Spec: Swagger 1.x (1.0, 1.1, 1.2) Import Support

- Status: **shipped**
- Date: 2026-09-15
- Builds on: `docs/specs/2026-09-13-wirebench-rest-client-design.md`, `docs/specs/2026-09-14-swagger-2-import-design.md`, `docs/specs/2026-09-14-swagger-and-openapi-3-2-import-design.md`, ADR-0003, and ADR-0005.

## Assumptions I'm making

1. **Clean-room translation directly into `OpenApiDocument`.**
   Swagger 1.x documents (versions 1.0, 1.1, 1.2) are parsed and converted directly into the internal `OpenApiDocument` representation within `packages/engine/src/rest/openapi/parse.ts`, enabling all existing downstream features (request mapping, code generation, UI representation) to operate without alteration.
2. **Version detection accommodates both modern and legacy conventions.**
   Swagger 1.2 API Declarations specify `swaggerVersion: "1.2"` (or `1.0`, `1.1`). Some tools declare `swagger: "1.2"`. The parser accepts both `swaggerVersion` and `swagger` root keys starting with `1.`.
3. **Swagger 1.x Model Resolution & Inlining with Memoization.**
   Swagger 1.x represents schemas inside a top-level `models` object. Types referenced in parameters or property `$ref`/`type` fields are resolved against `models` and inlined as standard JSON Schemas. To prevent exponential blowup on deeply nested or branching reference graphs, model resolution is memoized per model name.
4. **Base URL derivation.**
   The base URL is read from the `basePath` property. If absent, it defaults to `/`.
5. **Authorization conversion.**
   Swagger 1.2 `authorizations` (e.g. `apiKey`, `basicAuth`, `oauth2`) map to `OpenApiSecurityScheme` entries.

---

## 1. Objective

**What.** Extend Wirebench's REST import engine to support Swagger 1.0, 1.1, and 1.2 API specifications, converting them into executable `OpenApiDocument` structures with operations, request bodies, parameters, and authentication.

**Why.**
- Certain legacy enterprise services and legacy API documentation portals only supply Swagger 1.2 API declarations.
- Supporting 1.x alongside 2.0 and 3.x provides complete historical coverage of Swagger / OpenAPI formats within Wirebench.

---

## 2. Technical Stack & Architecture

- **`packages/engine/src/rest/openapi/model.ts`**:
  - `OpenApiVersion` includes `'1.2'`.
- **`packages/engine/src/rest/openapi/parse.ts`**:
  - `versionOf`: Recognizes `swaggerVersion` or `swagger` starting with `1.` and maps to version `'1.2'`.
  - `parseSwagger1Document`:
    - Reads `basePath` to construct `servers`.
    - Parses `resourcePath` and `info` to generate tags and metadata.
    - Iterates `apis` and nested `operations` to build `OpenApiOperation` list.
    - Resolves `paramType: "body"` and `paramType: "form"` into `OpenApiRequestBody`.
    - Converts `paramType: "path" | "query" | "header"` into `OpenApiParameter`.
    - Converts `models` into JSON Schemas with memoization in `Swagger1ModelContext`.
    - Maps `authorizations` into `OpenApiSecurityScheme`.

---

## 3. Project Structure & Affected Files

```
packages/engine/
├── src/rest/openapi/
│   ├── model.ts             # OpenApiVersion includes '1.2'
│   └── parse.ts             # parseSwagger1Document implementation
└── test/unit/rest/openapi/
    ├── parse.test.ts        # Swagger 1.x parsing & memoization tests
    └── import.test.ts       # Swagger 1.x end-to-end import tests
fixtures/openapi/crafted/
└── v12/                     # Crafted Swagger 1.2 test fixtures
```

---

## 4. Commands

```bash
pnpm vitest run packages/engine/test/unit/rest/openapi/
WIREBENCH_SKIP_PERF=1 pnpm check
```

---

## 5. Success Criteria

- [x] `versionOf({ swaggerVersion: '1.2' })` returns `{ version: '1.2', declared: 'Swagger 1.2' }`.
- [x] Swagger 1.x API Declarations with operations, parameters, and models import cleanly.
- [x] Model references resolve accurately with cycle detection and memoization preventing exponential blowup ($N=40$ resolves in $<500$ms).
- [x] `WIREBENCH_SKIP_PERF=1 pnpm check` passes.
