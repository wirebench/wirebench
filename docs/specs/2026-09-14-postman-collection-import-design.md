# Spec: Postman Collection (v2.0 & v2.1) Import Support

- Status: **draft** (under review)
- Date: 2026-09-14
- Builds on: `docs/specs/2026-09-13-wirebench-rest-client-design.md` (§3.6 REST import, §15.6 import roadmap), ADR-0003 (project format), ADR-0007 (APIs beside interfaces), and `docs/roadmap.md`.
- Decisions this spec needs from the owner are collected in §9, each with the default the rest of the document assumes.

## Assumptions I'm making

1. **Clean-room translation directly into Wirebench's `RestApi` model.**
   Postman collection JSON files (schema v2.0.0 and v2.1.0) are parsed and mapped directly into Wirebench's `RestApi`, `RestFolder`, and `RestRequestDef` models in `packages/engine/src/rest/postman/`. No external Postman libraries or dependencies are used.
2. **Variable syntax translation (`{{var}}` → `${var}`).**
   Postman uses double-curly-braces `{{var}}` for variable interpolation, while Wirebench uses `${var}` for its scope hierarchy (request → API → environment → workspace → global). During import, `{{var}}` references in URLs, header values, query parameters, form fields, and raw body templates are translated to `${var}` so they resolve against Wirebench's property scopes immediately.
3. **Path parameter normalization (`:param` → `{param}`).**
   Postman uses `:param` in path segments (e.g. `/users/:userId`). Wirebench represents path parameters with `{param}` and a corresponding entry in `request.pathParams`. The importer normalizes `:param` to `{param}` and populates `pathParams` using Postman's `url.variable` definitions.
4. **Nested folders and items.**
   Postman collections organize requests using recursive `item` arrays. Items with an `item` array become `RestFolder`s; items with a `request` object become `RestRequestDef`s. Nesting is preserved up to 64 levels; deeper collections (and inputs over 50 MB) are rejected with a `PostmanError` (`postman-too-deep`, `postman-too-large`). Items with no usable `request` are skipped and counted in a summary warning.
5. **Request bodies:**
   - `raw`: Maps to `RestBody` `{ kind: 'raw', text, language, contentType }`. The language is determined by `options.raw.language` (`json`, `xml`, `html`, `javascript`, `text`) or inferred from headers (defaulting to `json`).
   - `urlencoded`: Maps to `RestBody` `{ kind: 'form', fields: KeyValueEntry[] }`.
   - `formdata`: Maps to `RestBody` `{ kind: 'multipart', parts: MultipartFormPart[] }` (supporting text parts and file attachment parts).
   - `file`: Maps to `RestBody` `{ kind: 'binary', source: { kind: 'path', path: '' }, contentType }`.
   - `none` or absent: Maps to `{ kind: 'none' }`.
6. **Authentication translation:**
   - Collection-level or folder-level `auth` maps to `RestApi.auth` or `RestFolder.auth`.
   - Request-level `auth`:
     - If absent or `type: "inherit"`: `{ type: 'inherit' }`.
     - Credentials (passwords, tokens, API key values, client secrets) are keychain references in Wirebench and are **not copied**; the import summary warns that they must be re-entered.
     - `basic`: username maps to `AuthConfig` `{ type: 'basic', username }`.
     - `bearer`: maps to `AuthConfig` `{ type: 'bearer' }`.
     - `apikey`: key and in (`header` or `query`) map to `AuthConfig` `{ type: 'api-key', in, name: key }`.
     - `oauth2`: maps available flow tokens and URLs to `AuthConfig` `{ type: 'oauth2', ... }`.
     - `noauth`: maps to `AuthConfig` `{ type: 'none' }`.
7. **Desktop UI Integration:**
   - An IPC channel `api.importPostman` runs the import in main process.
   - Explorer right-click context menu on a project includes *Import Postman Collection…*.
   - Command palette includes `rest.importPostman`.
   - Dialog `ImportPostmanDialog` supports picking a `.json` file or pasting JSON directly, selecting a target project (or creating a new project named after the collection), and displaying the import summary (requests, folders, auth).
8. **Work happens in git worktree `git-worktrees/openapi-3.2` on branch `feat/openapi-3.2-support`.**

→ Correct any of these and the spec changes accordingly.

---

## 1. Objective

**What.** Add clean-room support to import Postman Collections (v2.0 and v2.1 JSON files) into Wirebench, converting collections, folders, requests, parameters, bodies, and auth configurations into native Wirebench `RestApi` entities.

**Why.**
- Postman collections are the most widely shared ad-hoc REST API format across development teams.
- Developers migrating to Wirebench frequently need to import their existing Postman collections without having to re-create dozens of requests, parameters, headers, and request bodies by hand.
- Native import eliminates migration friction and delivers on the product vision of a protocol-neutral API workbench.

**User Stories.**
- I have a Postman collection exported as `collection.json`. I click *Import Postman Collection…*, select the file, and Wirebench creates an API containing all my folders and requests.
- I import a Postman request with path parameters (`:id`) and query parameters with descriptions. Wirebench imports them as `{id}` with the path variable table filled in and query parameters enabled/disabled according to Postman's flags.
- I import a Postman collection using variables like `{{baseUrl}}` and `{{apiKey}}`. Wirebench converts them to `${baseUrl}` and `${apiKey}` so they work seamlessly with Wirebench Environments.
- I import a Postman request with JSON raw body or multipart form-data. Wirebench creates the proper request body with syntax highlighting and fields preserved.

---

## 2. Technical Stack & Architecture

### 2.1 Engine (`packages/engine/src/rest/postman/`)

```
packages/engine/src/rest/postman/
├── model.ts             # Postman Collection v2 schema types & intermediate representation
├── parse.ts             # Tolerant parser, version/schema detection, normalization
├── map.ts               # Pure mapping from Postman Collection to RestApi, RestFolder, RestRequestDef
├── import.ts            # Entry points: parsePostman, importPostmanCollection
└── index.ts             # Public module exports
```

- **`model.ts`**:
  Defines readonly interfaces for Postman Collection v2: `PostmanCollection`, `PostmanItem`, `PostmanRequest`, `PostmanUrl`, `PostmanHeader`, `PostmanBody`, `PostmanAuth`, `PostmanVariable`.
- **`parse.ts`**:
  - `isPostmanCollection(root: unknown): boolean`: Detects Postman schema URL (`schema.getpostman.com/json/collection/v2...`) or structural indicators (`info.name` and `Array.isArray(item)`).
  - Normalizes URLs: converts `:param` to `{param}`.
  - Replaces variable tokens: `{{var}}` → `${var}` in text fields.
- **`map.ts`**:
  - `apiFromPostmanCollection(collection, options): MappedApi`:
    Recursively maps `item` array:
    - If entry has `item` (array): creates `RestFolder` (recursing child folders and requests).
    - If entry has `request`: creates `RestRequestDef`.
    - Maps `auth` at collection, folder, and request levels.
    - Maps headers, query parameters, path variables (`pathParams`), and body (`raw`, `form`, `multipart`, `binary`, `none`).
- **`import.ts`**:
  - `importPostmanCollection(source: PostmanSource, options)`: Reads file/text/URL source and runs parser and mapper, returning `{ api: RestApi, summary: PostmanImportSummary }`.

### 2.2 Desktop Main Process (`apps/desktop/src/main/`)

- Add `PostmanImportService` (or method on import runner) to handle `api.importPostman` IPC channel.
- Validates file paths under existing path-access rules (`main/path-access.ts`).
- Adds API to project via `ProjectRouter.addApi`.

### 2.3 Desktop Renderer (`apps/desktop/src/renderer/`)

- Add `ImportPostmanDialog`:
  - Tabs: *File* (`.json` file picker) and *Paste* (raw JSON editor).
  - Target project selection: Existing project or *New Project* (default name populated from collection title).
  - Summary display showing: API name, request count, folder count, auth detected.
- Wire into project context menu (*Import Postman Collection…*) and command palette (`rest.importPostman`).

---

## 3. Project Structure & Affected Files

```
packages/engine/
├── src/rest/postman/
│   ├── model.ts
│   ├── parse.ts
│   ├── map.ts
│   ├── import.ts
│   └── index.ts
├── src/index.ts                                # Export postman import APIs
└── test/unit/rest/postman/
    ├── parse.test.ts                           # Parser & variable conversion tests
    ├── map.test.ts                             # Entity mapping unit tests
    └── import.test.ts                          # End-to-end collection import tests
fixtures/postman/
└── crafted/
    └── v21/sample-collection.json              # Crafted collection exercising all features
apps/desktop/
├── src/shared/commands.ts                      # Add rest.importPostman command
├── src/shared/ipc.ts                           # Add api.importPostman channel
├── src/shared/wire-types.ts                    # Add Postman import wire schemas
├── src/main/ipc/api.ts                         # Register api.importPostman handler
├── src/renderer/features/explorer/
│   ├── import-postman-dialog.tsx               # Postman import dialog component
│   └── context-menu.tsx                        # Add Import Postman Collection item
└── test/renderer/
    └── import-postman-dialog.test.tsx          # Dialog unit tests
```

---

## 4. Verification Strategy

1. **Unit Tests (`packages/engine/test/unit/rest/postman/`)**:
   - Detection of Postman Collection v2.0 and v2.1.
   - Variable substitution: `{{baseUrl}}/api/v1` → `${baseUrl}/api/v1`.
   - Path parameter conversion: `/users/:id/books/:bookId` → `/users/{id}/books/{bookId}`.
   - Body mapping for raw JSON, urlencoded form, and multipart form-data.
   - Recursive folder tree mapping and request ordering.
   - Auth translation for Basic, Bearer, API Key, and OAuth2.
2. **Integration Tests (`packages/engine/test/unit/rest/postman/import.test.ts`)**:
   - Import complete crafted Postman collection fixture end-to-end.
   - Verify generated `RestApi`, requests, headers, and folder structures.
3. **Desktop Tests (`apps/desktop/test/renderer/import-postman-dialog.test.tsx`)**:
   - Verify dialog renders file and paste tabs.
   - Verify IPC invocation and summary rendering.
4. **Full Verification Gate**:
   - `WIREBENCH_SKIP_PERF=1 pnpm check` passes with 0 errors/warnings.
   - `pnpm check:banned-terms` passes cleanly.

---

## 5. Boundaries

- **Always**:
  - Keep implementation completely clean-room with zero third-party dependencies.
  - Maintain 100% backward compatibility for existing OpenAPI/Swagger imports.
  - Skip and report unrecognized items gracefully rather than throwing fatal errors.
- **Never**:
  - Introduce prohibited competitor names.
  - Touch or modify disk files directly from renderer.

---

## 6. Success Criteria

- [ ] Postman Collection v2.0 and v2.1 JSON files can be imported via file or text paste.
- [ ] Nested folders and requests are preserved in exact hierarchy and order.
- [ ] Variables (`{{var}}` → `${var}`) and path parameters (`:param` → `{param}`) are properly translated.
- [ ] All body types (raw, urlencoded, multipart) and auth types (basic, bearer, apiKey) map accurately.
- [ ] Full quality gate (`WIREBENCH_SKIP_PERF=1 pnpm check`) passes with 0 regressions.
