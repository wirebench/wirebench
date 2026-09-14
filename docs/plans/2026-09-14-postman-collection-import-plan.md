# Plan: Postman Collection (v2.0 & v2.1) Import Support

Builds on `docs/specs/2026-09-14-postman-collection-import-design.md`.

## Goals

1. Implement clean-room Postman Collection v2.0 and v2.1 JSON parser in `packages/engine/src/rest/postman/`:
   - Identify Postman collections by schema URL or structural fingerprint (`info.name`, `item`).
   - Translate variable references from `{{var}}` to `${var}` across URLs, headers, query params, form bodies, and raw body templates.
   - Normalize path parameters from `:param` to `{param}` and match with `url.variable` definitions.
2. Implement pure entity mapper in `packages/engine/src/rest/postman/map.ts`:
   - Map recursive `item` hierarchies to `RestFolder[]` and `RestRequestDef[]`.
   - Map `auth` at collection, folder, and request levels (Basic, Bearer, API Key, OAuth2, None/Inherit).
   - Map request bodies: `raw` (JSON, XML, text, HTML, JS), `urlencoded` form, `formdata` multipart, and binary.
3. Add engine import pipeline and export through `@wirebench/engine`:
   - `parsePostmanCollection`, `importPostmanCollection`.
4. Add desktop IPC channel `api.importPostman` and UI dialog `ImportPostmanDialog`:
   - Support file selection and raw JSON paste.
   - Support project selection (existing project or new project).
   - Display summary on import completion (requests, folders, auth).
5. Comprehensive test coverage:
   - Unit tests for parser, variable translation, URL normalization, and entity mapping.
   - Integration tests for end-to-end import of crafted Postman collection fixture.
   - Desktop dialog component tests.
6. Verify full quality gate: `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm check:banned-terms`.

---

## Vertical Slices & Task Breakdown

### Slice 1: Postman Model & Parser (`packages/engine`)
- **Files**:
  - `packages/engine/src/rest/postman/model.ts`: Postman Collection v2.0/v2.1 types and summary types.
  - `packages/engine/src/rest/postman/parse.ts`:
    - `isPostmanCollection`: validate collection JSON.
    - `parsePostmanCollection`: parse text into `PostmanCollection`.
    - `translatePostmanVariables`: convert `{{var}}` to `${var}`.
    - `normalizePostmanUrl`: convert `:param` in path segments to `{param}`.
- **Tests**:
  - `packages/engine/test/unit/rest/postman/parse.test.ts`:
    - Test collection detection and validation.
    - Test variable conversion (`{{baseUrl}}/v1` → `${baseUrl}/v1`).
    - Test URL and path variable normalization (`/users/:userId` → `/users/{userId}`).

### Slice 2: Postman Entity Mapping & Import (`packages/engine`)
- **Files**:
  - `packages/engine/src/rest/postman/map.ts`:
    - `apiFromPostmanCollection`: pure mapping from `PostmanCollection` to `RestApi`, `RestFolder[]`, `RestRequestDef[]`.
    - Map auth: collection-level, folder-level, and request-level auth configs.
    - Map headers, query parameters, path variables.
    - Map bodies: `raw` (with syntax detection), `urlencoded`, `formdata`, `file`.
  - `packages/engine/src/rest/postman/import.ts`:
    - `importPostmanCollection(source, options)`: supports file and text sources.
  - `packages/engine/src/rest/postman/index.ts` and `packages/engine/src/index.ts`: export Postman import APIs.
- **Tests**:
  - `packages/engine/test/unit/rest/postman/map.test.ts`:
    - Test folder hierarchy recursion and request ordering.
    - Test auth inheritance and override.
    - Test body conversions (JSON raw, urlencoded, multipart).

### Slice 3: Fixtures & Integration Tests
- **Files**:
  - `fixtures/postman/crafted/v21/sample-collection.json`: crafted collection with nested folders, path variables, query params, auth, and bodies.
  - `packages/engine/test/unit/rest/postman/import.test.ts`: end-to-end import test of fixture.

### Slice 4: Desktop IPC & UI Integration (`apps/desktop`)
- **Files**:
  - `apps/desktop/src/shared/wire-types.ts`: define `apiImportPostmanRequestSchema` and response schema.
  - `apps/desktop/src/shared/ipc.ts`: register `api.importPostman` channel.
  - `apps/desktop/src/shared/commands.ts`: add `rest.importPostman` command.
  - `apps/desktop/src/main/ipc/api.ts`: handle `api.importPostman` request, invoke engine, and add to project.
  - `apps/desktop/src/renderer/features/explorer/import-postman-dialog.tsx`: dialog component with File and Paste tabs.
  - `apps/desktop/src/renderer/features/explorer/context-menu.tsx`: add *Import Postman Collection…* option.
  - `apps/desktop/src/renderer/shell/app-shell.tsx`: mount `ImportPostmanDialog`.
- **Tests**:
  - `apps/desktop/test/renderer/import-postman-dialog.test.tsx`: test dialog rendering, tab switching, and import completion.

### Slice 5: Quality Gate & Verification
- Run `pnpm --filter @wirebench/engine build`.
- Run all unit, integration, and desktop tests.
- Run `WIREBENCH_SKIP_PERF=1 pnpm check`.
- Run `pnpm check:banned-terms`.

---

## Verification Plan

```bash
# In git-worktrees/openapi-3.2:

# 1. Build engine:
pnpm --filter @wirebench/engine build

# 2. Run postman unit and integration tests:
pnpm vitest run packages/engine/test/unit/rest/postman/

# 3. Run desktop tests:
pnpm vitest run apps/desktop/test/renderer/import-postman-dialog.test.tsx

# 4. Run full verification gate:
WIREBENCH_SKIP_PERF=1 pnpm check

# 5. Check banned terms:
pnpm check:banned-terms
```
