# Spec: Swagger 2.0 (OpenAPI 2.0) Import Support

- Status: **shipped**
- Date: 2026-09-14
- Builds on: `docs/specs/2026-09-13-wirebench-rest-client-design.md` (§3.6 OpenAPI import, §15.6 OpenAPI 2.0 converter roadmap item), `docs/specs/2026-09-14-swagger-and-openapi-3-2-import-design.md`, ADR-0003 (project format), ADR-0005 (path and reference safety), and `docs/roadmap.md`.
- Decisions this spec needs from the owner are collected in §9, each with the default the rest of the document assumes.

## Assumptions I'm making

1. **Clean-room translation directly into the intermediate `OpenApiDocument` model.**
   Swagger 2.0 documents are parsed and converted directly into the existing `OpenApiDocument` model in `packages/engine/src/rest/openapi/parse.ts`. This means downstream mapping (`map.ts`), sample generation (`sample.ts`), reference resolution (`refs.ts`), definition caching (`cache.ts`), and the desktop UI consume the result without architectural changes or runtime dependencies.
2. **Server and Base URL derivation from `host`, `basePath`, and `schemes`.**
   Swagger 2.0 specifies server URLs across three root fields: `host` (string), `basePath` (string), and `schemes` (`http` / `https`). We derive `servers: [{ url: ... }]` by combining them:
   - If `host` is present: `${scheme}://${host}${basePath ?? ''}` (for each scheme in `schemes`, defaulting to `https` if unspecified).
   - If only `basePath` is present: `${basePath}`.
   - If neither is present: fallback to `/`.
3. **Parameter separation and request body generation:**
   - In Swagger 2.0, request bodies are represented either as:
     - A parameter with `in: "body"`, carrying a `schema` and optional `example`.
     - Parameters with `in: "formData"`, defining urlencoded form fields or multipart file parts.
   - We extract `bodyParam` and `formDataParams` from `parameters`:
     - A `bodyParam` maps to `OpenApiRequestBody` whose media types match `consumes` (defaulting to `['application/json']`).
     - `formDataParams` map to `OpenApiRequestBody` with an object schema whose properties represent the form fields, selecting `multipart/form-data` if any parameter has `type: "file"`, and `application/x-www-form-urlencoded` otherwise.
   - Remaining parameters (`in: "query" | "header" | "path"`) have their primitive type attributes (`type`, `format`, `items`, `enum`, `default`) synthesized into a `JsonSchema` on `OpenApiParameter.schema`.
4. **Security definitions conversion:**
   - `type: "basic"` maps to `type: "http", scheme: "basic"`.
   - `type: "apiKey"` maps to `type: "apiKey", in: def.in, keyName: def.name`.
   - `type: "oauth2"` maps `flow: "application"` to `flows.clientCredentials` and `flow: "accessCode"` to `flows.authorizationCode`.
5. **Reference resolution works without changes:**
   Swagger 2.0 references typically point to `#/definitions/...` or `#/parameters/...`. Because `refs.ts` implements RFC 6901 JSON pointers directly against the document tree, references to `#/definitions/...` resolve automatically.
6. **Work happens in git worktree `git-worktrees/openapi-3.2` on branch `feat/openapi-3.2-support`.**

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Extend Wirebench's REST import engine to support Swagger 2.0 documents (`swagger: "2.0"`), converting them into the engine's internal `OpenApiDocument` representation so they produce executable REST APIs, folders, requests, sample bodies, and authentication identical to OpenAPI 3.x imports.

**Why.**
- Many enterprise, legacy, and cloud APIs still expose Swagger 2.0 specifications (`swagger.json`).
- While Swagger 3.0.x / 3.1.x / 3.2.0 and OpenAPI 3.x are already supported, users currently attempting to import a genuine Swagger 2.0 document receive an error directing them to convert the file first.
- Implementing native, zero-dependency ingestion eliminates this friction and delivers on the roadmap item (§15.6).

**User Stories.**
- I import a Swagger 2.0 document (e.g. `swagger: "2.0"`) by URL or file. Wirebench imports it cleanly without error, creates requests with all path/query/header parameters and sample bodies, and records `Swagger 2.0` on the API card.
- I import a Swagger 2.0 document containing a body parameter with schema and `consumes: [application/json]`. Wirebench generates a sample JSON body.
- I import a Swagger 2.0 document with `in: "formData"` and `type: "file"`. Wirebench produces a multipart request body with a file part.
- I import a Swagger 2.0 document with `securityDefinitions` (Basic auth, API key, OAuth2). Wirebench maps the security schemes to API authentication candidates.

---

## 2. Technical Stack & Architecture

- **`packages/engine/src/rest/openapi/model.ts`**:
  - Extend `OpenApiVersion` to `'2.0' | '3.0' | '3.1' | '3.2'`.
- **`packages/engine/src/rest/openapi/parse.ts`**:
  - Update `versionOf`:
    - If `swagger` starts with `'2.'` or equals `'2.0'`, return `{ version: '2.0', declared: `Swagger ${swagger}` }`.
  - Add Swagger 2.0 parsing logic in `parseOpenApiDocument`:
    - When `version === '2.0'`, route to `parseSwagger2Document(root, declared, skipped)`.
    - `parseSwagger2Servers(root)`: Combine `schemes`, `host`, and `basePath`.
    - `parseSwagger2Operations(root, skipped)`:
      - Walk paths and methods.
      - Separate parameters: `bodyParam`, `formDataParams`, and standard parameters (`path`, `query`, `header`).
      - Synthesize primitive schemas for standard parameters.
      - Construct `OpenApiRequestBody` from `bodyParam` or `formDataParams`.
    - `parseSwagger2SecuritySchemes(root, skipped)`:
      - Map `securityDefinitions` into `OpenApiSecurityScheme[]`.
    - `parseSecurityRequirements` & `parseTags`:
      - Reuse existing helper functions as Swagger 2.0 structures match OpenAPI 3.

---

## 3. Project Structure & Affected Files

```
packages/engine/
├── src/rest/openapi/
│   ├── model.ts             # Add '2.0' to OpenApiVersion
│   └── parse.ts             # Swagger 2.0 parser & translation to OpenApiDocument
└── test/unit/rest/openapi/
    ├── parse.test.ts        # Swagger 2.0 parsing unit tests
    └── import.test.ts       # Swagger 2.0 end-to-end import tests
fixtures/openapi/crafted/
└── v20/                     # Crafted Swagger 2.0 fixture exercising all constructs
e2e/specs/
└── openapi-import.spec.ts   # Update test from refusal to successful import
```

---

## 4. Commands

```bash
# In worktree git-worktrees/openapi-3.2:
pnpm vitest run packages/engine/test/unit/rest/openapi/
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm check:banned-terms
```

---

## 5. Testing Strategy

1. **Unit tests (`packages/engine/test/unit/rest/openapi/parse.test.ts`)**:
   - `versionOf({ swagger: '2.0' })` returns `{ version: '2.0', declared: 'Swagger 2.0' }`.
   - Swagger 2.0 server URL composition from `host`, `basePath`, `schemes`.
   - Parameter conversion from primitive attributes to `JsonSchema`.
   - Request body conversion from `in: body` parameter and `in: formData` parameters.
   - `securityDefinitions` conversion for Basic, API Key, and OAuth2.
2. **Integration tests (`packages/engine/test/unit/rest/openapi/import.test.ts`)**:
   - End-to-end import of a complete Swagger 2.0 document.
   - Validates resulting `RestApi`, requests, sample body generation, and auth candidates.
3. **E2E tests (`e2e/specs/openapi-import.spec.ts`)**:
   - Update existing test to verify that importing a Swagger 2.0 URL succeeds.
4. **Full Verification Gate**:
   - `WIREBENCH_SKIP_PERF=1 pnpm check`.

---

## 6. Boundaries

- **Always**:
  - Keep parser clean-room and dependency-free.
  - Zero changes to downstream `map.ts`, `sample.ts`, `cache.ts`.
  - Preserve all existing OpenAPI 3.0, 3.1, and 3.2 behaviour.
- **Never**:
  - Fail an import on malformed operations or unknown extensions (skip and count).
  - Use banned competitor terms.

---

## 7. Success Criteria

- [x] `versionOf({ swagger: '2.0' })` returns `{ version: '2.0', declared: 'Swagger 2.0' }`.
- [x] Swagger 2.0 documents import into valid `RestApi` models with correct base URLs.
- [x] Both body parameter and form data parameter bodies are imported as valid REST request bodies.
- [x] Security schemes from `securityDefinitions` are mapped and selectable.
- [x] All 5,000+ existing tests pass with 0 regressions.
- [x] `WIREBENCH_SKIP_PERF=1 pnpm check` passes with 0 warnings/errors.
