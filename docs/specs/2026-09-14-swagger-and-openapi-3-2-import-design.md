# Spec: Swagger 3.x and OpenAPI 3.2 Import Support

- Status: **shipped**
- Date: 2026-09-14
- Builds on: `docs/specs/2026-09-13-wirebench-rest-client-design.md` (§3 OpenAPI 3 import, §15 decisions), ADR-0003 (project format), ADR-0005 (path and reference safety), and `docs/roadmap.md`.
- Decisions this spec needs from the owner are collected in §9, each with the default the rest of the document assumes.

## Assumptions I'm making

1. **"Swagger 3.0.x, 3.1.x, and 3.2.0" refers to documents using the `swagger` property with 3.x versions.**
   In the wild, users and certain code generators mistakenly author OpenAPI 3.x documents using `"swagger": "3.0.0"`, `"swagger": "3.1.0"`, or `"swagger": "3.2.0"` instead of `"openapi": "3.x.y"`. Wirebench will accept these documents, interpret them according to the corresponding OpenAPI 3.x specification, and preserve the declared version string (e.g. `swagger: 3.0.3` or `3.0.3`) in the API definition.
2. **Swagger 2.0 and 1.x conversion are implemented as clean-room converters.**
   Originally planned as a rejection directing users to convert documents first, Wirebench has implemented direct clean-room conversion of Swagger 2.0 and Swagger 1.x documents into the intermediate `OpenApiDocument` representation (see `docs/specs/2026-09-14-swagger-2-import-design.md` and `docs/specs/2026-09-15-swagger-1x-import-design.md`).
3. **OpenAPI 3.2 is fully backward-compatible with 3.1.**
   OpenAPI Specification 3.2.0 is a minor version bump over 3.1. The existing JSON Schema Draft 2020-12 dialect, parameter model, and body preference work without breaking changes.
4. **OpenAPI 3.2 additions are consumed where they influence requests; otherwise skipped and counted.**
   - `additionalOperations`: Supported so custom or extension HTTP methods (e.g., `QUERY`, WebDAV verbs) declared under a Path Item are imported as REST requests rather than dropped.
   - Example Object `dataValue` and `serializedValue`: Read in addition to `value` so 3.2-style examples generate body samples and parameter values accurately.
   - Media Type `itemSchema`: Read alongside `schema` for streaming/sequential media types (`text/event-stream`, `application/jsonl`).
   - Root `$self`: Recognized as the document's canonical self-URL when resolving relative references.
   - Other 3.2-only metadata (`tags[].parent`, `tags[].kind`, `securitySchemes[].deprecated`) are either mapped into existing fields or counted in `skipped` without failing import.
5. **No new runtime dependencies are introduced.**
   All parsing, version detection, and model transformations remain in-house using existing dependencies (`yaml`).
6. **Work happens in git worktree `git-worktrees/openapi-3.2` on branch `feat/openapi-3.2-support`.**

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Extend Wirebench's REST OpenAPI import engine to accept:
1. OpenAPI 3.2.x documents (`openapi: 3.2.0`, `openapi: 3.2.x`).
2. Documents declaring Swagger 3.x (`swagger: 3.0.x`, `swagger: 3.1.x`, `swagger: 3.2.0`).
3. OpenAPI 3.2 features that affect request structure (`additionalOperations`, `itemSchema`, `dataValue`/`serializedValue`, root `$self`).

**Why.**
- OpenAPI 3.2.0 is the latest specification release from the OpenAPI Initiative (OAI), introducing support for modern protocols (streaming media types, `QUERY` method, self-referential document URIs).
- Many legacy tools, custom generators, and users mistakenly write `swagger: 3.0.0` instead of `openapi: 3.0.0` or call OpenAPI 3 "Swagger 3". Currently, Wirebench rejects all documents containing a `swagger` field with an error advising users that only OpenAPI 3.0 and 3.1 are supported. Tolerating `swagger: 3.x` enables users to import these descriptions without requiring manual file edits.

**Who.**
- API engineers and testers working with services described by OpenAPI 3.2 specifications.
- Users importing documents produced by generators that emit `swagger: 3.x`.

**User Stories.**
- I import an OpenAPI 3.2.0 document containing a `QUERY /search` operation under `additionalOperations`. Wirebench creates a `QUERY /search` REST request with its parameters and body.
- I import a document declaring `swagger: 3.0.3`. Wirebench imports it cleanly without throwing an unsupported version error, recording `swagger: 3.0.3` in the API definition summary.
- I import an OpenAPI 3.2 document using `dataValue` in an Example Object. Wirebench populates the sample request body using that example value.
- I attempt to import a Swagger 2.0 document (`swagger: 2.0`). Wirebench refuses it with a helpful error explaining that Swagger 2.0 requires conversion, while noting that OpenAPI 3.0, 3.1, and 3.2 are supported.

---

## 2. Technical Stack & Architecture

- **Engine (`packages/engine`)**:
  - `src/rest/openapi/model.ts`: Update `OpenApiVersion` to `'3.0' | '3.1' | '3.2'`.
  - `src/rest/openapi/parse.ts`:
    - Update `versionOf`:
      - Accept `openapi` starting with `3.0`, `3.1`, or `3.2`.
      - Accept `swagger` starting with `3.0`, `3.1`, or `3.2`, mapping to versions `'3.0'`, `'3.1'`, and `'3.2'` respectively, while preserving the declared string.
      - Reject unsupported Swagger versions (e.g. `swagger: 9.x`) with message: `This is a Swagger ${swagger} document. Wirebench imports Swagger 1.x, 2.0, 3.x and OpenAPI 3.0, 3.1, 3.2.`
    - Support OpenAPI 3.2 Path Item `additionalOperations`:
      - Parse operations from `item.additionalOperations` where keys define HTTP methods (e.g. `query`).
    - Support OpenAPI 3.2 Example Object `dataValue` and `serializedValue`:
      - Update `parseExamples` to read `value ?? dataValue ?? serializedValue`.
    - Support Media Type `itemSchema`:
      - If `schema` is absent on a media type object, check `itemSchema`.
    - Support `$self` resolution in `refs.ts`:
      - If a document defines `$self` as a valid absolute URL, it can inform the base location for relative reference resolution.
- **Desktop UI (`apps/desktop`)**:
  - `src/renderer/features/explorer/import-openapi-dialog.tsx`:
    - Display declared version faithfully (`OpenAPI 3.2.0`, `Swagger 3.0.3`, etc.).
  - `test/renderer/import-openapi-dialog.test.tsx` & `test/ipc-api.test.ts`:
    - Ensure OpenAPI 3.2 and Swagger 3.x strings pass IPC and render cleanly.

---

## 3. Project Structure & Affected Files

```
packages/engine/
├── src/rest/openapi/
│   ├── model.ts             # OpenApiVersion = '3.0' | '3.1' | '3.2', OpenApiExample extensions
│   ├── parse.ts             # versionOf(), parseOperations() [additionalOperations], parseExamples()
│   ├── refs.ts              # $self handling if applicable
│   └── sample.ts            # itemSchema consideration
└── test/unit/rest/openapi/
    ├── parse.test.ts        # Tests for versionOf (3.2, swagger 3.x, swagger 2.0 refusal)
    └── import.test.ts       # Integration tests with 3.2 and swagger 3 fixtures
fixtures/openapi/crafted/
└── v32/                     # Crafted OpenAPI 3.2 fixture exercising 3.2 features
```

---

## 4. Commands

```bash
# In worktree git-worktrees/openapi-3.2:
pnpm install
pnpm typecheck
pnpm test packages/engine/test/unit/rest/openapi/
WIREBENCH_SKIP_PERF=1 pnpm check
pnpm check:banned-terms
```

---

## 5. Code Style & Conventions

- **Clean-room descriptions**: Never mention prohibited vendor names (enforced by `pnpm check:banned-terms`).
- **No runtime overhead or unbounded recursion**: Respect `MAX_SAMPLE_DEPTH` and `MAX_SAMPLE_NODES`.
- **Pure mapping**: Keep parser and mapper pure functions, passing skipped items to summary.
- **Strict typing**: TypeScript `strict: true`, no `any`, proper type guards (`isRecord`, `asString`).

Example `versionOf` implementation style:
```typescript
export function versionOf(root: unknown): { readonly version: OpenApiVersion; readonly declared: string } {
  if (!isRecord(root)) {
    throw new OpenApiError('openapi-not-a-document', 'This file does not contain an OpenAPI document');
  }
  const swagger = asString(root['swagger']);
  if (swagger !== undefined) {
    if (swagger.startsWith('3.0')) {
      return { version: '3.0', declared: `Swagger ${swagger}` };
    }
    if (swagger.startsWith('3.1')) {
      return { version: '3.1', declared: `Swagger ${swagger}` };
    }
    if (swagger.startsWith('3.2')) {
      return { version: '3.2', declared: `Swagger ${swagger}` };
    }
    throw new OpenApiError(
      'openapi-unsupported-version',
      `This is a Swagger ${swagger} document. Wirebench imports OpenAPI 3.0, 3.1 and 3.2; convert it first.`,
      { details: { declared: swagger } },
    );
  }
  const declared = asString(root['openapi']);
  if (declared === undefined) {
    throw new OpenApiError(
      'openapi-not-a-document',
      'This file has no "openapi" or "swagger" version field, so it is not an OpenAPI document',
    );
  }
  if (declared.startsWith('3.0')) {
    return { version: '3.0', declared };
  }
  if (declared.startsWith('3.1')) {
    return { version: '3.1', declared };
  }
  if (declared.startsWith('3.2')) {
    return { version: '3.2', declared };
  }
  throw new OpenApiError(
    'openapi-unsupported-version',
    `OpenAPI ${declared} is not supported. Wirebench imports OpenAPI 3.0, 3.1 and 3.2.`,
    { details: { declared } },
  );
}
```

---

## 6. Testing Strategy

1. **Unit tests (`packages/engine/test/unit/rest/openapi/parse.test.ts`)**:
   - `versionOf`:
     - Accepts `openapi: '3.2.0'`, `openapi: '3.2.1'`.
     - Accepts `swagger: '3.0.0'`, `swagger: '3.0.3'`, `swagger: '3.1.0'`, `swagger: '3.2.0'`.
     - Refuses `swagger: '2.0'` with updated error text.
     - Refuses `openapi: '4.0.0'`.
   - `additionalOperations`:
     - Parses `additionalOperations: { query: { operationId: 'searchQuery', ... } }` into an operation with `method: 'query'`.
   - Examples with `dataValue` / `serializedValue`:
     - Correctly parsed into `OpenApiExample` and used in request generation.
2. **Integration tests (`packages/engine/test/unit/rest/openapi/import.test.ts`)**:
   - Import a complete OpenAPI 3.2 document with `QUERY` and streaming media type.
   - Import a document with `swagger: 3.0.3`.
3. **Quality gate (`pnpm check`)**:
   - Linting, formatting, banned terms check, typecheck, tests all green.

---

## 7. Boundaries

- **Always**:
  - Run `WIREBENCH_SKIP_PERF=1 pnpm check` before committing.
  - Keep commits made as `Mohammed Naami <m.naami@outlook.com>`.
  - Preserve backward-compatibility for all existing 3.0 and 3.1 documents.
- **Ask first**:
  - Changing UI dialog terminology or adding major new dependency.
  - Implementing full Swagger 2.0 to 3.x conversion (which is a separate roadmap item).
- **Never**:
  - Mention banned competitor tool names anywhere in code, comments, or tests.
  - Drop operations or fields silently (always count and report in `skipped`).

---

## 8. Success Criteria

- [ ] `versionOf({ openapi: '3.2.0' })` returns `{ version: '3.2', declared: '3.2.0' }`.
- [ ] `versionOf({ swagger: '3.0.0' })` returns `{ version: '3.0', declared: 'Swagger 3.0.0' }` (or similar clean label).
- [ ] `versionOf({ swagger: '3.1.0' })` returns `{ version: '3.1', declared: 'Swagger 3.1.0' }`.
- [ ] `versionOf({ swagger: '3.2.0' })` returns `{ version: '3.2', declared: 'Swagger 3.2.0' }`.
- [x] `versionOf({ swagger: '2.0' })` returns `{ version: '2.0', declared: 'Swagger 2.0' }` (superseded by Swagger 2.0 converter implementation).
- [ ] Operations defined under OpenAPI 3.2 `additionalOperations` are imported into requests.
- [ ] Example values using `dataValue` or `serializedValue` are parsed and used in sample request bodies.
- [ ] All 110+ existing engine openapi tests and desktop tests continue to pass.
- [ ] `WIREBENCH_SKIP_PERF=1 pnpm check` passes with 0 warnings/errors.

---

## 9. Decisions & Open Questions

1. **Declared Version Labeling for Swagger 3.x**:
   - *Option A (Default)*: Return `declared: 'Swagger ' + swagger` so the summary and definition card clearly indicate `OpenAPI (Swagger 3.0.3)` or `Swagger 3.0.3`.
   - *Option B*: Return `declared: swagger` (e.g. `'3.0.3'`).
   - *Default assumed*: Option A.
2. **Handling of `additionalOperations` HTTP Methods**:
   - *Option A (Default)*: Accept any method key defined in `additionalOperations` (e.g. `query`, `search`) and create requests with that method in uppercase (`QUERY`).
   - *Option B*: Restrict to a known set (e.g. `query`) and skip unknown ones.
   - *Default assumed*: Option A (Wirebench's HTTP transport and request model already support arbitrary HTTP method strings).
3. **Swagger 2.0 Scope**:
   - *Status*: Swagger 2.0 is supported and converted natively as specified in `docs/specs/2026-09-14-swagger-2-import-design.md`.
