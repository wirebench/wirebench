# Plan: Importers for Insomnia, Bruno `.bru`, Hoppscotch and Thunder Client

Spec: [`docs/specs/2026-10-15-other-clients-import-design.md`](../specs/2026-10-15-other-clients-import-design.md) (#588)

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended)
> or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`)
> syntax for tracking.

**Goal:** Import collections and environments from Insomnia, Bruno, Hoppscotch and Thunder Client
through the one Import… dialog and `wirebench import`.

**Architecture:** Each format is parsed into a typed model, then converted into a document an
existing importer maps: a Postman v2.1 document (Insomnia, Hoppscotch, Thunder Client) or an
`OcCollection` value (Bruno). The existing mappers produce the Wirebench model, so auth, bodies,
credentials, examples and the report behave as they do today. Desktop main and the CLI place the
result through one shared helper each.

**Tech Stack:** TypeScript, Vitest, zod (wire schemas), React (dialog), Playwright + Electron (e2e),
`yaml` (already an engine dependency).

**Format references** (field tables, version histories, samples, source links): read the one for
your format before its tasks.

- `docs/research/2026-10-15-insomnia-format.md`
- `docs/research/2026-10-15-bruno-format.md`
- `docs/research/2026-10-15-hoppscotch-format.md`
- `docs/research/2026-10-15-thunder-client-format.md`

## Global Constraints

- One commit per task, made once `WIREBENCH_SKIP_PERF=1 pnpm check` is green. No `Co-Authored-By`
  and no `Claude-Session` trailer. Commits as Mohammed Naami <m.naami@outlook.com>.
- `pnpm test:perf` passes before each push.
- No new third-party dependency.
- Engine parsing is pure: parsers take text, or a `ReadonlyMap<string, string>` of root-relative
  POSIX path → text. File access lives in desktop main and the CLI.
- Anything `packages/engine/src/import-detect.ts` imports must stay browser-safe (no `node:`
  imports); `apps/desktop/test/engine-detect-browser-bundle.test.ts` proves it.
- Renderer code imports from `apps/desktop/src/shared/wire-types.ts` with `import type` only: an
  eager value import breaks every e2e test through the CSP eval probe.
- No regular expression with nested or adjacent unbounded quantifiers runs on file content
  (CodeQL flags them even when linear). Split with `indexOf`, `lastIndexOf`, `startsWith`, `endsWith`.
- Size limits: a file is at most 50 MB (`MAX_OPENCOLLECTION_BYTES`, the Postman limit). A folder walk
  stops at 5,000 files, depth 64, 50 MB and 50,000 entries (`COLLECTION_V3_FOLDER_LIMITS`).
- Never write a secret value or a literal credential into a project, workspace or History file.
  Literal credentials are dropped by the shared mappers; converters pass them through untouched so
  those mappers can warn.
- Every imported script is saved as text under `imported-scripts/` and never run (owner decision 1).
  No v2.1 `event` is ever written by a converter.
- An import never activates an environment and never overwrites an existing environment, global,
  project property, secret or script file.
- Docs and code describe each format neutrally: no statement that a Wirebench feature was inspired
  by another product. `pnpm check:banned-terms` must pass.
- `.env` and `.env.*` files are never read by any walk.
- e2e runs need a build first: `pnpm build && xvfb-run -a pnpm test:e2e -- <spec>`. Locally on
  macOS, run e2e only in CI (no local Electron windows); run unit tests with `nice`.
- `eslint` OOMs with nested worktrees present: run lint as
  `NODE_OPTIONS=--max-old-space-size=8192 pnpm lint`.

## Review Focus

1. **A picked `.json` with an ordinary name** (`export.json`). People rename exports. Expect the
   dialog to detect Insomnia, Hoppscotch or Thunder Client from content, not to show "Unknown".
   Pinned by Task 5's `detectImportSource reads a renamed export` test.
2. **A Hoppscotch file mistaken for Thunder Client, or the reverse.** Both use `folders` and
   `requests`. Expect each to be detected as itself. Pinned in Task 4.
3. **A Bruno folder where one `.bru` file is broken** (hand-edited, a `//` comment line). Expect the
   rest of the collection to import and the report to name the file and line. Pinned in Task 14.
4. **Duplicate request names in one folder** (two "Get user" requests). Expect both to import and
   each to keep its own assertions (Thunder Client) and order. Pinned in Task 21.
5. **An export with secrets blanked** (Hoppscotch, Bruno, Insomnia vault, Thunder Client "remove
   secret values"). Expect each secret to arrive as a named secret with no value, listed as needing
   one, never as a plain empty property. Pinned in Tasks 9, 15, 18 and 21.

---

## Shared result type

Tasks 3, 9, 15, 18, 21 and 10, 16, 19, 22 use this type. It is defined in Task 3.

```ts
// packages/engine/src/import/client-import.ts
export type ClientFormat = 'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client';

export interface MappedClientImport {
  /** Same entry type as the v3 importer: one per source collection, each API present only when it has requests. */
  readonly collections: readonly MappedCollectionV3Entry[];
  readonly variables: ImportedVariables;
  readonly scripts: readonly ImportedScriptFile[];
  /** Root-relative `.proto` paths gRPC requests name (Bruno), or proto texts by name (Insomnia v4). */
  readonly protos: readonly { readonly name: string; readonly text: string }[];
  readonly counts: {
    readonly collections: number;
    readonly requests: number;
    readonly folders: number;
    readonly examples: number;
    readonly assertions: number;
    readonly scripts: number;
  };
  readonly report: ImportReport;
}
```

---

# PR 1: shared pieces and Insomnia

Branch `feat/588-insomnia-import` from `main`. Opening the PR moves #588 to **In review** only
after PR 4; until then it stays **In progress**.

### Task 1: One folder walk for every folder import

**Files:**
- Create: `packages/engine/src/import/read-folder.ts`
- Modify: `packages/engine/src/import/collection-v3/read-folder.ts` (its `walk` becomes a call)
- Test: `packages/engine/test/unit/import/read-folder.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ImportFolderOptions {
    readonly readFile: (name: string) => boolean;   // basename test
    readonly skipFolder?: (relPath: string) => boolean; // root-relative POSIX
    readonly limits?: CollectionV3FolderLimits;
    readonly error: (code: 'not-a-folder' | 'too-many-files' | 'too-deep' | 'too-large' | 'read-failed', message: string, cause?: unknown) => Error;
  }
  export async function readImportFolder(root: string, options: ImportFolderOptions): Promise<Map<string, string>>;
  ```
  `node_modules` and `.git` are always skipped. Move `COLLECTION_V3_FOLDER_LIMITS` here and
  re-export it from the v3 module.

- [ ] **Step 1: Write the failing tests** in a temp folder: `reads only files readFile accepts`,
  `skips node_modules and .git`, `skipFolder drops a subtree`, `never follows a symbolic link`,
  `refuses a root that is a link (not-a-folder)`, `stops at limits.files (too-many-files)`,
  `stops past limits.depth (too-deep)`, `keys are POSIX and root-relative`.
- [ ] **Step 2: Run** `nice pnpm vitest run --project engine-unit test/unit/import/read-folder.test.ts`.
  Expected: FAIL, module not found.
- [ ] **Step 3: Move** the v3 `walk`, `readNoFollow` and `inside` into `read-folder.ts` behind
  `readImportFolder`. `readCollectionV3Folder` calls it with `readFile: n => /\.(?:ya?ml|js)$/i.test(n)`
  and an `error` that builds the same `PostmanError` codes as today (`postman-v3-not-a-folder`,
  `postman-v3-too-many-files`, `postman-v3-too-deep`, `postman-too-large`, `postman-read-failed`).
- [ ] **Step 4: Run** the new test and `test/unit/import/collection-v3`. Expected: PASS, v3 tests unchanged.
- [ ] **Step 5: Commit** `refactor(engine): share the import folder walk (#588)`.

### Task 2: Template dialects

**Files:**
- Create: `packages/engine/src/import/template-dialects.ts`
- Test: `packages/engine/test/unit/import/template-dialects.test.ts`

**Interfaces:**
- Produces (each returns `{{x}}`-style text for `rewriteMustache`, and adds every construct it kept
  as written to `kept`, for the report):
  ```ts
  export function insomniaTemplates(text: string, kept: Set<string>, vaultRefs?: ReadonlyMap<string, string>): string;
  export function hoppscotchTemplates(text: string): string;
  export function thunderTemplates(text: string, kept: Set<string>): string;
  export function brunoTemplates(text: string, kept: Set<string>): string;
  ```
  `vaultRefs` maps a vault variable name to its `${secret:…}` reference.

- [ ] **Step 1: Write the failing tests**, one per spec §3.4 row:
  ```ts
  expect(insomniaTemplates('{{ _.base }}/x', kept)).toBe('{{base}}/x');
  expect(insomniaTemplates("{{ _['my-key'] }}", kept)).toBe('{{my-key}}');
  expect(insomniaTemplates('{{ _.db.host }}', kept)).toBe('{{db.host}}');
  expect(insomniaTemplates('{{ _.users[0].id }}', kept)).toBe('{{users.0.id}}');
  expect(insomniaTemplates('{{ base }}', kept)).toBe('{{base}}');
  expect(insomniaTemplates("{% uuid 'v4' %}", kept)).toBe('{{$guid}}');
  expect(insomniaTemplates("{% now 'iso-8601' %}", kept)).toBe('{{$isoTimestamp}}');
  expect(insomniaTemplates("{% now 'unix' %}", kept)).toBe('{{$timestamp}}');
  expect(insomniaTemplates("{% now 'millis' %}", kept)).toBe("{% now 'millis' %}"); // kept
  expect(insomniaTemplates("{% response 'body', 'req_1', 'b64::JC5h::46b', 'never', 60 %}", kept)).toContain('{% response');
  expect(kept).toContain('response');
  expect(insomniaTemplates('{{ _.vault.tok }}', kept, new Map([['tok', '${secret:sec_1}']]))).toBe('${secret:sec_1}');
  expect(insomniaTemplates('{{ _.base | upcase }}', kept)).toBe('{{ _.base | upcase }}'); // filter kept
  expect(hoppscotchTemplates('<<base>>/a/<<$guid>>')).toBe('{{base}}/a/{{$guid}}');
  expect(thunderTemplates('{{#guid}}', kept)).toBe('{{$guid}}');
  expect(thunderTemplates('{{tok | upper}}', kept)).toBe('{{tok | upper}}');
  expect(brunoTemplates('{{process.env.TOKEN}}', kept)).toBe('${#System#TOKEN}');
  expect(brunoTemplates('{{?Ask me}}', kept)).toBe('{{?Ask me}}');
  ```
  Also: `a 1 MB run of '{' returns within 50 ms` for each function.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** with a linear scanner (find `{{`/`{%`/`<<`, then the matching close with
  `indexOf`). Thunder Client `#` names map `guid → $guid`, `timestamp → $timestamp`; any other `#`
  name is kept. A `{% … %}` tag name is the first word after `{%`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): rewrite other clients' template syntax (#588)`.

### Task 3: Shared result type, script collector, value flattening and placement in main

**Files:**
- Create: `packages/engine/src/import/client-import.ts`
- Create: `apps/desktop/src/main/import-place.ts`
- Modify: `packages/engine/src/import/index.ts` (export the new module)
- Modify: `apps/desktop/src/main/ipc/api.ts` (`importPostmanFolder` uses `placeMappedImport`)
- Test: `packages/engine/test/unit/import/client-import.test.ts`, `apps/desktop/test/import-place.test.ts`

**Interfaces:**
- Produces, in the engine:
  ```ts
  export type ClientFormat, MappedClientImport; // as in "Shared result type" above
  export class ScriptCollector {
    constructor(apiSlug: string, report: ReportBuilder);
    /** Saves non-empty `source` as `imported-scripts/<apiSlug>/<itemSlug>.<phase>.js`; `phase` is `pre`, `post` or `tests`. */
    add(itemSlug: string, phase: 'pre' | 'post' | 'tests', source: string, label: string): void;
    files(): ImportedScriptFile[];
    /** One warning naming the dialects seen: `pm.`, `insomnia.`, `pw.`, `hopp.`, `bru.`, `tc.`. */
    reportDialects(): void;
  }
  /** `{"db":{"host":"x"},"ids":[1]}` → [['db.host','x'],['ids.0','1']]; numbers and booleans become strings; null becomes ''. */
  export function flattenValue(name: string, value: unknown): [string, string][];
  ```
- Produces, in main:
  ```ts
  export async function placeMappedImport(
    deps: Pick<ApiChannelDeps, 'router' | 'variablesPorts'>,
    projectId: string,
    mapped: Pick<MappedClientImport, 'collections' | 'variables' | 'report'> & Partial<Pick<MappedClientImport, 'scripts'>>,
    meta: { readonly source: string; readonly declaredVersion: string },
  ): Promise<PlacedImport>;
  export interface PlacedImport { projectId: string; project?: ProjectWire; apiIds: string[]; variables?: ImportVariablesSummaryWire; scripts: number; warnings: string[]; notes: string[]; reportText: string }
  ```
  It is the body of today's `importPostmanFolder` `placeIn`, plus the `writeScriptsReported` call.

- [ ] **Step 1: Write the failing tests.** Engine: `ScriptCollector saves pre, post and tests under
  the API slug`, `ScriptCollector numbers a repeated item slug`, `ScriptCollector ignores blank
  source`, `reportDialects names each dialect once`, `flattenValue flattens nested objects and
  arrays`, `flattenValue keeps a string as it is`. Main: `placeMappedImport places rest, grpc and
  websocket APIs in order`, `applies variables only when the plan has some`, `writes scripts and
  reports a renamed one`, `merges mapped and variable reports`.
- [ ] **Step 2: Run** both tests. Expected: FAIL.
- [ ] **Step 3: Implement** both modules; switch `importPostmanFolder` to `placeMappedImport` with
  `declaredVersion: 'postman-collection-v3'`.
- [ ] **Step 4: Run** the new tests and `apps/desktop/test/renderer/import-postman-folder-dialog.test.tsx`
  plus the desktop `api` IPC tests. Expected: PASS.
- [ ] **Step 5: Commit** `refactor: one placement path for collection imports (#588)`.

### Task 4: Detection rules for the new formats

**Files:**
- Modify: `packages/engine/src/import-detect.ts`
- Test: `packages/engine/test/unit/import-detect-clients.test.ts`

**Interfaces:**
- Produces: `ImportFormatKind` gains `'insomnia' | 'insomnia-environment' | 'bruno' | 'hoppscotch' |
  'hoppscotch-environment' | 'thunder-client' | 'thunder-client-environment'`.
  ```ts
  /** A picked folder's format from its direct children's names (`name/` for a folder). */
  export function detectImportFolder(children: readonly string[]): DetectedImportFormat;
  ```
  Labels: `Insomnia export`, `Insomnia environments`, `Bruno collection`, `Hoppscotch collection`,
  `Hoppscotch environments`, `Thunder Client collection`, `Thunder Client environment`.
  The `*-environment` kinds target the workspace only (Task 6 hides the project picker for them).

- [ ] **Step 1: Write the failing tests**, content rules (definite):
  - v4 `{ "__export_format": 4, "resources": [] }` → `insomnia`; v5 YAML `type: collection.insomnia.rest/5.0` and
    `type: spec.insomnia.rest/5.0` → `insomnia`; `type: environment.insomnia.rest/5.0` → `insomnia-environment`.
  - Bruno JSON `{ "version": "1", "name": "x", "items": [] }` → `bruno`.
  - Hoppscotch `[{ "name": "c", "folders": [], "requests": [{ "endpoint": "https://a", "method": "GET" }] }]`
    and the single-object form → `hoppscotch`; GraphQL requests `{ "url": "…", "query": "…" }` →
    `hoppscotch`; `[{ "name": "e", "variables": [{ "key": "a" }] }]` → `hoppscotch-environment`.
  - `{ "clientName": "Thunder Client", "collectionName": "c", "requests": [] }` and the `client` form
    → `thunder-client`; with `environmentName` + `variables` → `thunder-client-environment`.
  - Neighbours: a Hoppscotch file whose requests carry `url` + `_id` + `colId` with the Thunder marker
    → `thunder-client`; a Postman collection, Postman environment, OpenCollection and OpenAPI document
    are detected exactly as before (existing `import-detect` tests stay green); an empty Hoppscotch
    collection (`requests: []`, no marker) → `hoppscotch` with `probable` confidence.
  - Names (probable): `Insomnia_2026-01-01.json`, `x.insomnia.yaml`, `hoppscotch-team-collections.json`,
    `thunder-collection_api.json`, `thunder-environment_dev.json`.
  - Folders: `['bruno.json','collection.bru','users/']` → `bruno`; `['bruno.json','opencollection.yml']`
    → `opencollection`; `['collections/','environments/']` with a `thunder-tests` root name is decided by
    main (Task 5), so `detectImportFolder(['thunderclient.json','thunderCollection.json'])` →
    `thunder-client`, `['collections/', 'environments/', 'thunderActivity.json']` → `thunder-client`;
    `['.resources/', 'a.request.yaml']` → `postman-v3`; anything else → `postman-v3` with `probable`.
- [ ] **Step 2: Run** the test. Expected: FAIL.
- [ ] **Step 3: Implement** the rules in `detectFromText` before the Postman rules, Thunder Client first,
  then Hoppscotch, then Insomnia, then Bruno JSON. Name rules join the existing name checks.
- [ ] **Step 4: Run** this test, the existing detect tests and `apps/desktop/test/engine-detect-browser-bundle.test.ts`.
  Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): detect Insomnia, Bruno, Hoppscotch and Thunder Client files (#588)`.

### Task 5: Detect a picked file or folder in main

A picked file's content never reaches the renderer, so detection there ran on the name only. This
task adds the content check the spec's §3.3 rules need.

**Files:**
- Modify: `apps/desktop/src/shared/kinds/rest/channels.ts`, `apps/desktop/src/shared/wire-types.ts`
- Modify: `apps/desktop/src/main/ipc/api.ts`
- Modify: `apps/desktop/src/renderer/features/explorer/import-dialog.tsx`
- Modify: `docs/specs/2026-10-15-other-clients-import-design.md` §3.3 (one paragraph naming this channel)
- Test: `apps/desktop/test/import-detect-source.test.ts`, `apps/desktop/test/renderer/import-dialog-detect-source.test.tsx`

**Interfaces:**
- Produces channel `api.detectImportSource`:
  `{ path: string, folder: boolean }` → `{ kind: ImportFormatKind, label: string, confidence: 'definite' | 'probable' | 'unknown' }`.
  A file: `checkedImportSource`, read with no-follow up to 50 MB, `detectImportFormat({ text, filename })`.
  A folder: `checkedImportSource`, its direct children listed (a folder's name gets a trailing `/`),
  `detectImportFolder`. A folder named `thunder-tests`, or holding `collections/` with any
  `tc_col_*.json` inside, is `thunder-client`.

- [ ] **Step 1: Write the failing tests:** `detectImportSource reads a renamed export` (an Insomnia v5
  file saved as `export.json` → `insomnia`), `classifies a Bruno folder`, `classifies a thunder-tests
  folder`, `refuses an unpicked path`. Renderer: `a picked file whose name is not definite asks main
  and shows the answer`, `a folder pick asks main instead of assuming postman-v3`, `a stale answer is
  dropped`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the channel and call it from the dialog after a pick when name-based
  detection is not `definite`, and after every folder pick. `FOLDER_FORMAT` is removed.
- [ ] **Step 4: Run** the tests and `apps/desktop/test/renderer/import-dialog.test.tsx`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): detect a picked import file or folder by content (#588)`.

### Task 6: The dialog's format table

No behaviour change for existing formats.

**Files:**
- Create: `apps/desktop/src/renderer/features/explorer/import-formats.ts`
- Modify: `apps/desktop/src/renderer/features/explorer/import-dialog.tsx`
- Test: `apps/desktop/test/renderer/import-formats.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface ImportFormatRow {
    readonly kind: ImportFormatKind;
    readonly label: string;               // dropdown text
    readonly tabs: readonly ('url' | 'file' | 'paste' | 'folder')[];
    readonly defaultName: string;
    readonly workspaceOnly: boolean;      // hides the project picker
    readonly fileFilters: readonly { name: string; extensions: readonly string[] }[];
  }
  export const IMPORT_FORMATS: readonly ImportFormatRow[];
  export function importFormatRow(kind: ImportFormatKind): ImportFormatRow;
  ```
  The IPC call stays in the dialog's `switch` on `effectiveFormat`; only data moves.

- [ ] **Step 1: Write the failing test** `every existing format keeps its label, tabs, default name,
  picker and filters`: a table of today's values read from the dialog (wsdl `Imported service`,
  postman `Imported Collection`, proto `Imported gRPC API`, har `Imported traffic`, http-file
  `Imported requests`, opencollection and postman-v3 `Imported collection`, others `Imported API`;
  workspace-only: postman-environment, postman-globals, http-env).
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** the table and replace the dialog's chained conditions for the default
  name, file filters, picker and tabs with `importFormatRow(effectiveFormat)`.
- [ ] **Step 4: Run** the new test and every `apps/desktop/test/renderer/import-*` test. Expected: PASS
  with no change to existing tests.
- [ ] **Step 5: Commit** `refactor(desktop): one table for the Import dialog's formats (#588)`.

### Task 7: Insomnia reader

**Files:**
- Create: `packages/engine/src/import/insomnia/model.ts`, `parse.ts`, `index.ts`
- Modify: `packages/engine/src/errors.ts` (add `InsomniaError`)
- Create: `fixtures/insomnia/crafted/v4.json`, `v4.yaml`, `v5-collection.yaml`, `v5-spec.yaml`,
  `v5-environment.yaml`, `v4-two-workspaces.json` (start from the samples in the research note §8)
- Test: `packages/engine/test/unit/import/insomnia/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface InsWorkspace { name: string; items: InsNode[]; baseEnv?: InsEnv; subEnvs: InsEnv[]; protos: { id: string; name: string; text: string; dirId?: string }[]; extras: string[] }
  export type InsNode =
    | { kind: 'folder'; id: string; name: string; children: InsNode[]; headers: InsRow[]; auth?: Rec; environment?: Rec; scripts: InsScripts; description?: string }
    | { kind: 'http'; id: string; name: string; method: string; url: string; parameters: InsRow[]; pathParameters: InsRow[]; headers: InsRow[]; body: Rec; auth?: Rec; settings: InsSettings; scripts: InsScripts; description?: string }
    | { kind: 'grpc'; id: string; name: string; url: string; protoFileId?: string; protoMethodName: string; message: string; metadata: InsRow[]; reflection: boolean }
    | { kind: 'websocket'; id: string; name: string; url: string; headers: InsRow[]; parameters: InsRow[]; auth?: Rec; payload?: string }
    | { kind: 'skipped'; name: string; what: string };
  export interface InsRow { name: string; value: string; disabled: boolean; description?: string; type?: string; fileName?: string; multiline?: string | boolean }
  export interface InsEnv { name: string; data: Rec; order?: Rec; color?: string; private: boolean }
  export interface InsScripts { pre: string; post: string }
  export interface InsSettings { followRedirects: 'global' | 'on' | 'off'; encodeUrl: boolean; other: string[] }
  export interface InsDocument { kind: 'collection' | 'environment'; workspaces: InsWorkspace[]; report: ImportReport }
  export function parseInsomnia(text: string): InsDocument;
  ```
  Errors: `insomnia-malformed`, `insomnia-too-large` (50 MB), `insomnia-old-format` (`__export_format`
  1–3, message asks for a re-export from a current Insomnia), `insomnia-not-collection` (mock or MCP
  file, message names the kind).

- [ ] **Step 1: Write the failing tests:** `v4 builds the tree from parentId`, `v4 splits two
  workspaces`, `v5 nests children`, `siblings sort by sortKey ascending, ties by id descending`
  (folders and requests interleaved), `v5 discriminates folder, http, grpc, websocket`, `a socket.io
  item is skipped and named`, `spec kind reads as a collection and reports its embedded spec`,
  `v5 environment file reads base and subs`, `v4 private sub-environment is kept with private: true`,
  `v4 proto_file texts are kept with their directory`, `v5 schema 5.0 rows with empty names are
  dropped`, `an extra type key on a v4 resource is ignored`, one test per error code.
- [ ] **Step 2: Run** `nice pnpm vitest run --project engine-unit test/unit/import/insomnia/parse.test.ts`.
  Expected: FAIL.
- [ ] **Step 3: Implement** `parseInsomnia` with `yaml`'s `parse` (defaults: no custom tags). v5 is
  recognised by its `type` value, not by the text starting with `type:`.
- [ ] **Step 4: Run** the test. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): read Insomnia v4 and v5 exports (#588)`.

### Task 8: Postman auth gains digest, AWS SigV4 and JWT

The Insomnia, Hoppscotch and Thunder Client converters all hand auth to the Postman mapper, which
today turns digest, AWS SigV4 and JWT into `none`.

**Files:**
- Modify: `packages/engine/src/rest/postman/map.ts` (`mapPostmanAuth`)
- Test: `packages/engine/test/unit/rest/postman/auth-digest-aws.test.ts`

- [ ] **Step 1: Write the failing tests:** `digest keeps the username and drops a literal password
  with the credential warning` → `{ type: 'digest', username: 'u' }`; `awsv4 keeps region and service`
  → `{ type: 'aws-sigv4', region: 'eu-west-1', service: 'execute-api' }` with the warning for literal
  keys; `a digest password that is only references is still dropped and warned`; `jwt keeps algorithm,
  claims, header prefix and placement` → `{ type: 'jwt', algorithm: 'HS256', claims: '{"sub":"1"}',
  issuedAt: false, jwtId: false, in: 'header', prefix: 'Bearer' }` with the literal secret or private
  key warned and never kept; `an unknown jwt algorithm becomes none, named`; `hawk, oauth1, akamai
  stay none with the type named`.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement** the three cases, reading the v2.1 attribute keys `username`, `password`
  (digest); `accessKey`, `secretKey`, `sessionToken`, `region`, `service` (awsv4); `algorithm`,
  `secret`, `privateKey`, `payload`, `headerPrefix`, `addTokenTo` (`header` or `queryParam`),
  `queryParamKey` (jwt). The algorithm must be one of `JWT_ALGORITHMS` in
  `packages/engine/src/http/auth/jwt-algorithms.ts`.
- [ ] **Step 4: Run** it and `test/unit/rest/postman`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): map digest, AWS SigV4 and JWT auth from Postman collections (#588)`.

### Task 9: Insomnia to Wirebench

**Files:**
- Create: `packages/engine/src/import/insomnia/convert.ts`, `map.ts`, `import.ts`
- Test: `packages/engine/test/unit/import/insomnia/convert.test.ts`, `map.test.ts`, `golden.test.ts`
  (+ `__snapshots__`)

**Interfaces:**
- Consumes: `parseInsomnia` (Task 7), `insomniaTemplates` (Task 2), `ScriptCollector`,
  `flattenValue`, `MappedClientImport` (Task 3), `parsePostmanCollection`, `apiFromPostmanCollection`.
- Produces:
  ```ts
  /** The v2.1 document for one workspace's HTTP requests and folders. */
  export function v21OfInsomnia(ws: InsWorkspace, name: string, report: ReportBuilder, kept: Set<string>, vaultRefs: ReadonlyMap<string, string>): Json;
  export interface MapInsomniaOptions { newId?: IdGenerator; firstOrder?: number; name?: string }
  export function mapInsomnia(doc: InsDocument, options?: MapInsomniaOptions): MappedClientImport;
  export async function importInsomnia(source: { kind: 'file'; path: string } | { kind: 'text'; text: string }, options?: MapInsomniaOptions): Promise<MappedClientImport>;
  ```

- [ ] **Step 1: Write the failing tests**, one per spec §4.2–4.5 row:
  - URL keeps its own query; enabled and disabled `parameters` append with `disabled` kept; `:id`
    becomes `{id}` with the `pathParameters` value.
  - Folder headers copy onto requests lacking the name, with the note.
  - Each `mimeType` row: JSON/XML/YAML/EDN/text raw; urlencoded form; multipart text part, file part
    with `fileName` kept and noted, string `multiline` as part content type; GraphQL with object and
    string `variables`, and an unparseable string kept as text; octet-stream binary; absent body none;
    `Content-Type` added from `mimeType` when missing.
  - Auth: each supported type maps (through Task 8 for digest and `iam`); `{}` and `disabled: true`
    inherit; `none` stops inheritance; `oauth1`, `hawk`, `asap`, `netrc`, `singleToken` → none with
    the type named; bearer `prefix: 'NO_PREFIX'` keeps the raw token.
  - Settings: `followRedirects` on/off map, `global` is default; `encodeUrl` maps; cookie, render and
    rebuild-path are noted.
  - A request with `Accept: text/event-stream` stays a REST request with that header.
  - gRPC: `grpcs://` sets TLS; `/pkg.Svc/M` gives service and method; v4 proto attached via
    `protos`; v5 reports no definition; reflection noted.
  - WebSocket: v4 payload becomes one saved message; v5 notes payloads are not exported.
  - Environments: base → project properties; subs → workspace environments with `#rrggbb` colour
    kept and a non-hex colour dropped; folder environments → project properties outermost first, first
    wins; nested values flatten; `dataPropertyOrder` sets order; vault names → secrets with no value,
    listed; `{{ _.vault.x }}` points at that secret; an environment file merges its base into Globals.
  - Scripts: request and folder scripts saved as text through `ScriptCollector`, none attached;
    dialect warning names `insomnia.`.
  - Reported: cookie jar, unit test suites (with request names), API spec, mock, Socket.IO, MCP, each
    kept template tag with the requests using it.
  - Golden: `fixtures/insomnia/crafted/v5-collection.yaml` → snapshot of the `MappedClientImport`
    with deterministic ids.
  - **Review Focus 5:** `a vault secret arrives as a named secret with no value, never a plain property`.
- [ ] **Step 2: Run** the three tests. Expected: FAIL.
- [ ] **Step 3: Implement.** Each workspace becomes one `MappedCollectionV3Entry`; gRPC and WebSocket
  APIs follow the v3 importer's naming (`<name> (gRPC)`, `<name> (WebSocket)` when several kinds).
  The v2.1 document carries `item.request.auth` in v2.1 shape and never an `event`.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): map Insomnia exports onto Wirebench APIs (#588)`.

### Task 10: Insomnia in the desktop

**Files:**
- Modify: `apps/desktop/src/shared/kinds/rest/channels.ts`, `apps/desktop/src/shared/wire-types.ts`
- Modify: `apps/desktop/src/main/ipc/api.ts`
- Modify: `apps/desktop/src/renderer/features/explorer/import-formats.ts`, `import-dialog.tsx`
- Test: `apps/desktop/test/import-insomnia.test.ts`, `apps/desktop/test/renderer/import-insomnia-dialog.test.tsx`

**Interfaces:**
- Produces two wire schemas every client format reuses:
  ```ts
  apiImportClientRequestSchema = z.object({ target: projectAddInterfaceTargetSchema, source: clientSourceSchema, name: z.string().max(200).optional() });
  clientSourceSchema = z.discriminatedUnion('kind', [{kind:'file',path}, {kind:'folder',path}, {kind:'text',text}]);
  apiImportClientResponseSchema // ApiImportOpenCollectionResponse's fields, with counts = MappedClientImport['counts']
  apiImportClientEnvironmentsRequestSchema = z.object({ format: z.enum(['insomnia','hoppscotch','thunder-client']), source: clientSourceSchema });
  // response: apiImportPostmanVariablesResponseSchema
  ```
  Channels: `api.importInsomnia` and `api.importClientEnvironments`. Format rows: `insomnia` (File,
  Paste; picker shown; default name `Imported collection`; filters JSON and YAML) and
  `insomnia-environment` (File, Paste; workspace only).

- [ ] **Step 1: Write the failing tests.** Main: `imports a picked v5 file into a new project`,
  `imports pasted v4 JSON`, `removes a created project when placing fails`, `an environment file
  goes to the workspace with no project`. Renderer: `the Insomnia row shows File and Paste and the
  picker`, `the environment row hides the picker`, `the report lists vault secrets needing values`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** the handlers with `checkedImportSource`, `importInsomnia` and
  `placeMappedImport` (`declaredVersion: 'insomnia'`), protos through the existing `.proto` import.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(desktop): import Insomnia exports (#588)`.

### Task 11: `wirebench import` reads client formats

**Files:**
- Modify: `packages/cli/src/ops/import.ts`
- Test: `packages/cli/test/unit/ops/import-clients.test.ts`

**Interfaces:**
- Consumes: `importInsomnia` now; Tasks 16, 19 and 22 add `importBruno`, `importHoppscotch`,
  `importThunderClient` to the same dispatch.
- Produces: `ImportOutput.format` gains `'insomnia' | 'bruno' | 'hoppscotch' | 'thunder-client'`.
  `addCollectionV3` is renamed `addMappedCollections(context, project, mapped, format)` and serves v3
  and every client format; the v3 path calls it with the mapped v3 result. An `*-environment` kind
  is refused with code `environments-not-imported` and the existing message.

- [ ] **Step 1: Write the failing tests:** `imports an Insomnia file as its APIs with plain variables as
  properties`, `leaves secrets out and names them (secret-not-imported)`, `reports environments as not
  imported`, `keeps an existing property value (property-kept)`, `refuses an Insomnia environment
  file`, and the existing v3 tests unchanged.
- [ ] **Step 2: Run** `nice pnpm vitest run --project cli-unit test/unit/ops`. Expected: FAIL.
- [ ] **Step 3: Implement**; update the op `description` and the `source` describe text to name the
  new formats.
- [ ] **Step 4: Run** it, then `pnpm docs:commands` to regenerate the CLI reference. Expected: PASS.
- [ ] **Step 5: Commit** `feat(cli): import Insomnia exports (#588)`.

### Task 12: Insomnia docs and e2e

**Files:**
- Create: `docs-site/src/content/docs/switching/insomnia.mdx`
- Modify: `docs-site/src/content/docs/guides/importers.mdx` (format table row + section with limits),
  `CHANGELOG.md` (`[Unreleased]` → Added), `docs/cli.md` if `docs:commands` did not cover it
- Create: `e2e/specs/insomnia-import.spec.ts`, `e2e/fixtures/insomnia/collection.yaml`

- [ ] **Step 1: Write the e2e case** `imports an Insomnia v5 file and shows its folders and report`,
  modelled on `e2e/specs/opencollection-import.spec.ts`.
- [ ] **Step 2: Write the docs:** mapping tables in the style of `switching/postman.mdx`, neutral
  wording; limits (50 MB, v1–v3 refused, v5 has no proto text or WebSocket payloads).
- [ ] **Step 3: Run** `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: PASS (includes
  `check:doc-paths`, `check:banned-terms`, prettier). The e2e case runs in CI.
- [ ] **Step 4: Commit** `docs: Insomnia import (#588)`, push, open PR 1 titled
  `feat: import Insomnia exports (#588, PR 1 of 4)`, tick the Insomnia box on #588.

---

# PR 2: Bruno

Branch `feat/588-bruno-import` from `main` after PR 1 merges.

### Task 13: The `.bru` reader

**Files:**
- Create: `packages/engine/src/import/bruno/lexer.ts`, `parse.ts`, `model.ts`, `index.ts`
- Modify: `packages/engine/src/errors.ts` (add `BrunoError`)
- Test: `packages/engine/test/unit/import/bruno/parse.test.ts`, `parse-hostile.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export type BruGrammar = 'request' | 'folder' | 'environment';
  export interface BruPair { key: string; value: string; enabled: boolean; annotations: { name: string; arg?: string }[] }
  export type BruBlock =
    | { kind: 'dict'; name: string; pairs: BruPair[]; line: number }
    | { kind: 'text'; name: string; text: string; line: number }
    | { kind: 'list'; name: string; items: { value: string; enabled: boolean }[]; line: number };
  export interface BruFile { blocks: BruBlock[] }
  /** @throws BrunoError `bruno-parse-error` with `file` and `line` */
  export function parseBru(text: string, grammar: BruGrammar, file: string): BruFile;
  export function block(file: BruFile, name: string): BruBlock | undefined;
  export function blocks(file: BruFile, name: string): BruBlock[];
  ```

- [ ] **Step 1: Write the failing tests**, one per spec §5.1 rule, using the research note §2 grammar:
  dictionary pairs; a text block loses two leading spaces; a block ends only at a line starting with
  `}`, so an indented `}` inside a script stays; `'''` values lose four characters per line then trim;
  a value keeps every `:` after the first; a quoted key with `:` and `\"`; `~key` and `~"key"` disabled;
  annotation lines (`@number`, `@description('''…''')`) attach to the next pair; multipart
  `@file(a.png|b.png)` and a trailing `@contentType(text/plain)` stay in the raw value for Task 14;
  `tags: [` list items one per line; environment `vars:secret [ a, ~b ]`; `\r\n` input; a `//` line in
  a dictionary fails with `bruno-parse-error` naming file and line.
  Hostile (`parse-hostile.test.ts`): an unterminated block fails; a 10 MB single line; 100,000 tiny
  blocks; a `'''` that never closes. Each finishes within 2 s and fails or parses without hanging.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** a line-based scanner (no parser generator, no regex over whole lines with
  nested quantifiers).
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): read Bruno .bru files (#588)`.

### Task 14: Bruno collection to OpenCollection

**Files:**
- Create: `packages/engine/src/import/bruno/convert.ts`
- Modify: `packages/engine/src/import/opencollection/auth.ts` (`digest`, `awsv4` cases)
- Create: `fixtures/bruno/crafted/basic/…` (the research note §10 sample collection, completed with a
  gRPC request, a WebSocket request, an `app` item and one broken `.bru` file)
- Test: `packages/engine/test/unit/import/bruno/convert.test.ts`,
  `packages/engine/test/unit/import/opencollection/auth-digest-aws.test.ts`

**Interfaces:**
- Consumes: `parseBru` (Task 13), `brunoTemplates` (Task 2).
- Produces:
  ```ts
  /** `files`: root-relative path → text, as Task 16's walk hands them over. */
  export function ocOfBrunoFolder(files: ReadonlyMap<string, string>, rootName: string): { collection: OcCollection; report: ImportReport };
  ```
  `mapOcAuth` gains `digest` (`{ type: 'digest', username }`, literal password warned) and `awsv4`
  (`{ type: 'aws-sigv4', region, service }`, literal keys warned).

- [ ] **Step 1: Write the failing tests**, one per spec §5.2–5.3 row:
  - Layout: name from `bruno.json`; `collection.bru` defaults; `folder.bru` name and `seq`; a folder
    without one is named after its directory; `environments/` not read as requests; `.env` absent from
    `files` is fine; `mocks/` and `bruno.json` `ignore` paths dropped.
  - Order by `meta.seq` then name; a missing `seq` counts as 1.
  - Verb block method; `http { method: PURGE }`; query from `params:query` only, never also from the
    URL; `:id` path values from `params:path`.
  - Only the body mode the verb block names is used; another body block left in the file is noted;
    each mode (`json`, `text`, `xml`, `sparql`, `graphql` + `body:graphql:vars`, `formUrlEncoded`,
    `multipartForm` with `@file` and `@contentType`, `file` with `~file:` unselected).
  - Auth: request `auth:` mode with its block; folder and collection `auth { mode }`; `inherit`; `none`;
    `digest` and `awsv4` map; `wsse`, `oauth1`, `akamai-edgegrid` become none with the type named.
  - gRPC `grpc { url, method, methodType, protoPath }`, `metadata`, first `body:grpc` used, others noted.
  - WebSocket `ws { url }`, each `body:ws` a saved message.
  - `vars:pre-request` on collection and folders → project properties; on a request → reported;
    `vars:post-response` → reported as needing a script or capture.
  - `assert` lines become `OcAssertion`s: `res.status: eq 200`, a bare value means `eq`, a disabled
    line, an operator Wirebench lacks (`between`) reported.
  - `settings` `timeout`, `followRedirects`, `maxRedirects`, `encodeUrl` map; `omitHeaders` becomes
    the request's omitted generated headers; `docs` → description; `app` item skipped and reported.
  - Scripts and `tests` blocks reach `runtime.scripts` (types `before-request`, `after-response`,
    `tests`) so OpenCollection's mapper saves them as text.
  - **Review Focus 3:** `a broken .bru file is reported with its line and the rest imports`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** `ocOfBrunoFolder` and the two auth cases.
- [ ] **Step 4: Run** them and `test/unit/import/opencollection`. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): convert Bruno collections to OpenCollection (#588)`.

### Task 15: Bruno environments, JSON export and import entry

**Files:**
- Create: `packages/engine/src/import/bruno/json-export.ts`, `import.ts`
- Create: `fixtures/bruno/crafted/export.json`
- Test: `packages/engine/test/unit/import/bruno/env.test.ts`, `json-export.test.ts`, `golden.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export function ocOfBrunoExport(json: unknown): { collection: OcCollection; report: ImportReport };
  export function mapBruno(collection: OcCollection, report: ImportReport, options?: MapOpenCollectionOptions & { name?: string }): MappedClientImport;
  export async function importBruno(source: { kind: 'folder'; path: string } | { kind: 'file'; path: string } | { kind: 'text'; text: string }, options?: MapOpenCollectionOptions & { name?: string }): Promise<MappedClientImport>;
  ```
  `importBruno` with a `bruno.json` file path reads its folder; with any other file reads it as the
  JSON export. Folder reads use `readImportFolder` with
  `readFile: n => /\.(?:bru|json|js|proto)$/i.test(n) && !n.startsWith('.env')` and
  `skipFolder: p => p === 'mocks'`.

- [ ] **Step 1: Write the failing tests:** environment `vars` with `~` disabled; `vars:secret [a]`
  → a secret with no value, listed (**Review Focus 5**); `{{process.env.X}}` value → `${#System#X}`;
  `extends`, `color`, `vars:externalsecrets:*` reported. JSON export: same `OcCollection` as the
  folder fixture for the same content; empty secrets listed; `brunoConfig` proxy reported and its
  password never copied; old `request.query` shape read. Folder walk: `a .env file is never read`
  (a `.env` holding `TOKEN=x` beside the collection; assert no imported value contains `x`). Golden
  snapshot of the folder fixture.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** `mapBruno` calls `mapOpenCollection` and wraps its result as one
  `MappedClientImport` entry.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): import Bruno environments and JSON exports (#588)`.

### Task 16: Bruno in the desktop, CLI and docs

**Files:**
- Modify: `apps/desktop/src/shared/kinds/rest/channels.ts` (`api.importBruno`, request
  `apiImportClientRequestSchema`, response `apiImportClientResponseSchema`), `apps/desktop/src/main/ipc/api.ts`,
  `import-formats.ts` (row `bruno`: Folder and File; picker shown; filters `bruno.json` and JSON),
  `import-dialog.tsx`, `packages/cli/src/ops/import.ts`
- Create: `docs-site/src/content/docs/switching/bruno.mdx`, `e2e/specs/bruno-import.spec.ts`,
  `e2e/fixtures/bruno/…`
- Modify: `guides/importers.mdx`, `CHANGELOG.md`
- Test: `apps/desktop/test/import-bruno.test.ts`, `apps/desktop/test/renderer/import-bruno-dialog.test.tsx`,
  `packages/cli/test/unit/ops/import-clients.test.ts` (Bruno cases)

- [ ] **Step 1: Write the failing tests:** main `imports a picked Bruno folder`, `a picked bruno.json
  stands for its folder`, `a folder with opencollection.yml goes to the OpenCollection importer`;
  renderer `the Bruno row shows Folder and File`; CLI `imports a Bruno folder with secrets left out`;
  e2e `picks a Bruno folder and shows its requests in seq order`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement**, then write the docs (limits: the folder walk limits; `.env` never read).
- [ ] **Step 4: Run** `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: import Bruno collections (#588)`, push, open PR 2, tick its box.

---

# PR 3: Hoppscotch

Branch `feat/588-hoppscotch-import` from `main` after PR 2 merges.

### Task 17: Hoppscotch reader with every schema version

**Files:**
- Create: `packages/engine/src/import/hoppscotch/model.ts`, `parse.ts`, `index.ts`
- Modify: `packages/engine/src/errors.ts` (add `HoppscotchError`)
- Create: `fixtures/hoppscotch/crafted/legacy-v0.json`, `v12-r17.json`, `gql.json`, `mixed-versions.json`,
  `environments-v2.json`, `environment-v0.json` (from the research note §8)
- Test: `packages/engine/test/unit/import/hoppscotch/parse.test.ts`

**Interfaces:**
- Produces a normalised, newest-shape model:
  ```ts
  export interface HopCollection { name: string; folders: HopCollection[]; requests: HopRequest[]; auth: Rec; headers: HopRow[]; variables: HopVariable[]; description?: string; pre: string; test: string }
  export type HopRequest =
    | { kind: 'rest'; name: string; method: string; endpoint: string; params: HopRow[]; headers: HopRow[]; body: { contentType: string | null; body: unknown }; auth: Rec; pre: string; test: string; requestVariables: HopRow[]; responses: Rec[]; description?: string }
    | { kind: 'graphql'; name: string; url: string; query: string; variables: string; headers: HopRow[]; auth: Rec; pre: string; test: string; responses: Rec[]; description?: string };
  export interface HopRow { key: string; value: string; active: boolean; description?: string }
  export interface HopVariable { key: string; value: string; secret: boolean }
  export function parseHoppscotchCollections(text: string): { collections: HopCollection[]; report: ImportReport };
  export function parseHoppscotchEnvironments(text: string): { environments: { name: string; variables: HopVariable[] }[]; report: ImportReport };
  ```
  Errors: `hoppscotch-malformed`, `hoppscotch-too-large`, `hoppscotch-not-collection`.

- [ ] **Step 1: Write the failing tests:** a single object and an array; legacy collection with no
  `v`; v0 REST request (`url` + `path`, string `auth` `"Basic Auth"`, `httpUser`) normalised as
  Hoppscotch's own migration does; REST `v` as a string and GraphQL `v` as a number; a folder at an
  older `v` than its parent; a version above the newest known read as the newest and named in the
  report; variable value `currentValue || initialValue || value`; environment v0, v1 secret with no
  value, v2.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement**, reading `v` per object.
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): read Hoppscotch exports of every version (#588)`.

### Task 18: Hoppscotch to Wirebench

**Files:**
- Create: `packages/engine/src/import/hoppscotch/convert.ts`, `import.ts`
- Test: `packages/engine/test/unit/import/hoppscotch/convert.test.ts`, `golden.test.ts`

**Interfaces:**
- Consumes: Task 17, `hoppscotchTemplates`, `ScriptCollector`, the Postman pipeline.
- Produces:
  ```ts
  export function mapHoppscotch(collections: HopCollection[], report: ImportReport, options?: { newId?: IdGenerator; firstOrder?: number; name?: string }): MappedClientImport;
  export function hoppscotchEnvironmentPlan(envs: { name: string; variables: HopVariable[] }[], report: ImportReport): ImportedVariables;
  export async function importHoppscotch(source: { kind: 'file'; path: string } | { kind: 'text'; text: string }, options?: …): Promise<MappedClientImport>;
  ```

- [ ] **Step 1: Write the failing tests**, one per spec §6.2–6.3 row: `<<x>>` rewritten; params not
  repeated when the endpoint query already has the name; inactive rows disabled; each body content
  type (JSON variants, XML, HTML, text raw; urlencoded `key: value` text → form, a `#`-prefixed line
  disabled; multipart text part and empty file part noted; octet-stream and `binary` → empty binary
  noted); each auth type including `authActive: false` and stale keys ignored, `hawk` and `akamai-eg`
  → none named; `jwt` maps through the v2.1 `jwt` attributes Task 8 reads; saved `responses` → examples; `requestVariables` reported;
  GraphQL request → GraphQL body; collection and folder auth, headers, variables (secret → secret with
  no value, **Review Focus 5**); scripts saved as text with `pw.`/`hopp.`/`pm.` dialects named.
  Environments: each a workspace environment; one named `Global` merges into Globals.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Each top-level collection is one `MappedCollectionV3Entry`.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): map Hoppscotch collections and environments (#588)`.

### Task 19: Hoppscotch in the desktop, CLI and docs

**Files:** as Task 16, for `api.importHoppscotch`, rows `hoppscotch` (File, Paste; picker) and
`hoppscotch-environment` (File, Paste; workspace only, through `api.importClientEnvironments`),
`switching/hoppscotch.mdx`, `e2e/specs/hoppscotch-import.spec.ts`.

- [ ] **Step 1: Write the failing tests:** main `imports a pasted collection array`, `environments go
  to the workspace`; renderer rows; CLI `imports a Hoppscotch collection`; e2e `imports a collection
  and its environments`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** and write the docs.
- [ ] **Step 4: Run** `WIREBENCH_SKIP_PERF=1 pnpm check`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: import Hoppscotch collections (#588)`, push, open PR 3, tick its box.

---

# PR 4: Thunder Client

Branch `feat/588-thunder-client-import` from `main` after PR 3 merges.

### Task 20: Thunder Client reader

**Files:**
- Create: `packages/engine/src/import/thunder/model.ts`, `parse.ts`, `index.ts`
- Modify: `packages/engine/src/errors.ts` (add `ThunderError`)
- Create: `fixtures/thunder-client/crafted/collection-1.0.json`, `collection-1.2.json`,
  `environment-1.0.json`, `environment-1.2-global.json`, `folder-v3/collections/tc_col_api.json`,
  `folder-v3/environments/tc_env_dev.json`, `folder-legacy/thunderclient.json`,
  `folder-legacy/thunderCollection.json`, `folder-legacy/thunderEnvironment.json` (from the research
  note §2–3, values fictional)
- Test: `packages/engine/test/unit/import/thunder/parse.test.ts`

**Interfaces:**
- Produces:
  ```ts
  export interface TcCollection { id: string; name: string; settings: Rec; folders: TcFolder[]; requests: TcRequest[] }
  export interface TcFolder { id: string; name: string; parentId: string; sortNum: number | null; settings: Rec }
  export interface TcRequest { id: string; name: string; folderId: string; method: string; url: string; reqType?: string; params: TcParam[]; headers: TcRow[]; body?: Rec; auth?: Rec; tests: TcTest[]; preReq?: Rec; postReq?: Rec; docs?: string; sortNum: number | null }
  export interface TcParam { name: string; value: string; isPath: boolean; disabled: boolean }
  export interface TcRow { name: string; value: string; disabled: boolean }
  export interface TcTest { type: string; custom: string; action: string; value: string }
  export interface TcEnvironment { name: string; global: boolean; variables: { name: string; value: string; secret: boolean; encrypted: boolean }[]; envFile?: string; flags: string[] }
  export function parseThunderExport(text: string): { collections: TcCollection[]; environments: TcEnvironment[]; report: ImportReport };
  /** `files`: root-relative path → text for every `*.json` under the folder. */
  export function parseThunderFolder(files: ReadonlyMap<string, string>): { collections: TcCollection[]; environments: TcEnvironment[]; report: ImportReport };
  ```
  Errors: `thunder-malformed`, `thunder-too-large`, `thunder-unsupported-layout` (no recognised file
  in the folder; message says one-file-per-request folders are not read yet).

- [ ] **Step 1: Write the failing tests:** `client` and `clientName` markers; `ref` ignored;
  `body.raw` string and line array joined with `\n`; `docs` string and array; a `tc_col_*.json` with
  `colName`; a `tc_env_*.json` with `data`; legacy requests grouped by `colId` into
  `thunderCollection.json` collections; `thunderActivity.json` ignored; an `_db-backup` folder
  ignored; an orphan `containerId` goes to the root; `encrypted: true` value treated as missing.
- [ ] **Step 2: Run** it. Expected: FAIL.
- [ ] **Step 3: Implement.**
- [ ] **Step 4: Run** it. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): read Thunder Client exports and folders (#588)`.

### Task 21: Thunder Client to Wirebench

**Files:**
- Create: `packages/engine/src/import/thunder/convert.ts`, `tests.ts`, `import.ts`
- Test: `packages/engine/test/unit/import/thunder/convert.test.ts`, `tests.test.ts`, `golden.test.ts`

**Interfaces:**
- Consumes: Task 20, `thunderTemplates`, `ScriptCollector`, the Postman pipeline, `folderRequests`.
- Produces:
  ```ts
  /** One test row as an assertion, or undefined when it has no Wirebench equivalent. */
  export function assertionOfThunderTest(test: TcTest): Assertion | undefined;
  export function mapThunderClient(parsed: ReturnType<typeof parseThunderExport>, options?: { newId?: IdGenerator; firstOrder?: number; name?: string }): MappedClientImport;
  export async function importThunderClient(source: { kind: 'file'; path: string } | { kind: 'folder'; path: string } | { kind: 'text'; text: string }, options?: …): Promise<MappedClientImport>;
  ```
  Assertions are attached after mapping by a request **trail** (folder names + request name + the
  occurrence index among same-named siblings), since the v2.1 document carries none.

- [ ] **Step 1: Write the failing tests**, one per spec §7.2–7.4 row:
  - Tree from `containerId`; folders before requests, each by `sortNum`, a `null` last.
  - `settings.options.baseUrl` becomes the server; `/x` and `x` under `http://h/api` and
    `http://h/api/` give `http://h/api/x` with no doubled slash; an absolute URL is untouched.
  - Query from non-path `params` with `isDisabled`; the URL's own query not read again; `{id}` from an
    `isPath` param.
  - Headers with `isDisabled`; collection and folder headers copied.
  - Each body type row; `Content-Type` added for `json`, `xml`, `text` when missing.
  - Auth: `basic`, flat `bearer` with `bearerPrefix`, `oauth2`, `aws`, `ntlm`, `none`; no `auth`
    inherits; any other type → none named.
  - `reqType: "sse"` stays REST; `docs` → description; another `reqType` skipped and reported.
  - Tests (`tests.test.ts`): `res-code equal 200` → `{ type: 'status', … }` with 200; `res-time < 500`
    → `{ type: 'sla', maxMs: 500 }` and `<=` the same; `json-query equal` with `custom: 'json.a.b[0]'`
    → `{ type: 'match', language: 'jsonpath', expression: '$.a.b[0]', equals: '…' }`; `json-query
    contains` → `matches` with the value regex-escaped; a `custom` holding `|`, `res-body` rows, header
    rows (`type: 'Content-Type'`), `count`, `istype` and `set-env-var` → undefined and reported.
  - Collection and folder test rows copied onto each request below.
  - Environments: secrets with a value go to the secret store plan; with none, listed (**Review Focus
    5**); `envFile` arrives empty and the report names the file; `default` and `local` noted; a
    `global` environment merges into Globals.
  - Reported: `preReq.runRequests`, `settings.runOptions`, `settings.envId`, attached script paths.
  - **Review Focus 4:** `two same-named requests in one folder keep their own assertions and order`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement.** Scripts in `preReq.inlineScripts` and `postReq.inlineScripts` saved as
  text, `tc.` dialect named.
- [ ] **Step 4: Run** them. Expected: PASS.
- [ ] **Step 5: Commit** `feat(engine): map Thunder Client collections, tests and environments (#588)`.

### Task 22: Thunder Client in the desktop, CLI and docs

**Files:** as Task 16, for `api.importThunderClient`, rows `thunder-client` (File, Folder; picker)
and `thunder-client-environment` (File; workspace only, through `api.importClientEnvironments`),
`switching/thunder-client.mdx`, `e2e/specs/thunder-client-import.spec.ts`. Folder reads use
`readImportFolder` with `readFile: n => n.toLowerCase().endsWith('.json')` and
`skipFolder: p => p.split('/').some(s => s.startsWith('_db-backup'))`.

- [ ] **Step 1: Write the failing tests:** main `imports a picked thunder-tests folder`, `imports a
  legacy folder`, `an environment export goes to the workspace`, `a one-file-per-request folder is
  refused with thunder-unsupported-layout`; renderer rows; CLI `imports a Thunder Client export`;
  e2e `picks a thunder-tests folder and shows its base URL as the server`.
- [ ] **Step 2: Run** them. Expected: FAIL.
- [ ] **Step 3: Implement** and write the docs (note the closed-source caveat neutrally: fields read
  are the ones current exports carry).
- [ ] **Step 4: Run** `WIREBENCH_SKIP_PERF=1 pnpm check` and `pnpm test:perf`. Expected: PASS.
- [ ] **Step 5: Commit** `feat: import Thunder Client collections (#588)`, push, open PR 4, tick its
  box, move #588 to **In review**.

---

## Spec coverage

| Spec | Tasks |
| --- | --- |
| §3.1 two pipelines | 9, 14–15, 18, 21 |
| §3.2 module layout, errors, limits | 1, 7, 13, 17, 20 |
| §3.3 detection | 4, 5 |
| §3.4 template dialects | 2 |
| §3.5 scripts | 3, 9, 14, 18, 21 |
| §3.6 folder picks | 1, 15, 22 |
| §3.7 dialog table | 6, 10, 16, 19, 22 |
| §3.8 IPC, CLI | 10, 11, 16, 19, 22 |
| §4 Insomnia | 7–12 |
| §5 Bruno | 13–16 |
| §6 Hoppscotch | 17–19 |
| §7 Thunder Client | 20–22 |
| §8 docs | 12, 16, 19, 22 |
| §9 testing | every task; perf in 22 |

Changes to the spec this plan makes, recorded in Task 5's spec edit:

- **Content detection for picked files.** A new channel, `api.detectImportSource`, checks a picked file's content, because the renderer only sees its name.
- **Environment-only formats.** Each tool's environment-only file gets its own `*-environment` kind, so the dialog can hide the project picker.
- **One environment channel.** The three tools' environment files share `api.importClientEnvironments`, which replaces the spec's `api.importHoppscotchEnvironments`.
- **Digest, AWS SigV4 and JWT auth.** The Postman mapper gains all three in Task 8 and the OpenCollection mapper gains digest and AWS SigV4 in Task 14, so they map instead of becoming `none`.
