# Spec: Legacy single-XML SOAP project import

- Status: **approved** (owner ruling of 2026-09-18 on issue #55)
- Date: 2026-09-18
- Builds on: `docs/specs/2026-09-14-postman-collection-import-design.md` (the import pattern this mirrors),
  ADR-0003 (project format), ADR-0004 (credentials live in the keychain) and `docs/roadmap.md`.

## 1. Objective

Many SOAP testers keep their work in a single XML project file written by an older desktop workbench. This
import reads that file and adds its SOAP interfaces, endpoints, saved requests and project properties to a
Wirebench project, so that work can move to Wirebench without being rebuilt by hand.

## 2. Rulings this spec rests on

1. **Import it.** This reverses the roadmap's earlier "no other tool's format" position.
2. **Clean room.** The only upstream source consulted is the format's published XML Schema, read for element
   and attribute names and nesting, together with the format as observed in public sample files. No
   implementation code of any other tool was read, and none may be. Fixtures are written by hand; no
   third-party project file is copied into the repository.
3. **Scope of v1: requests and endpoints.** Test suites, mock services, REST services, security
   configurations, database connections and auth profiles are not mapped. Each is listed in the import
   report with the reason.
4. **Scripts are kept, never run.** Wirebench has no scripting yet. Every script in the file is written, as
   is, to `imported-scripts/` in the project folder and listed in the report. Nothing reads that folder.
5. **The format's own identifiers are exempt from the banned-terms check in two places only:**
   `packages/engine/src/soap/legacy-project/format.ts` (the namespace URI and root element name) and
   `fixtures/legacy-soap-project/`. Docs, UI text and every other file stay checked. User-facing text calls
   it a "legacy SOAP project".

## 3. The format, as far as v1 reads it

A single XML document in one namespace (see `format.ts`), whose root element carries the project `name`.

| Element | Read as |
|---|---|
| root `@name`, `description` | project name, description |
| `properties/property` (`name`, `value`) | project properties |
| `interface` with `@type` of the WSDL kind | one SOAP interface. `@name`, `@definition` (WSDL URL), `@bindingName`, `@soapVersion` (`1_1`/`1_2`) |
| `interface/definitionCache` (`@rootPart`, `part/url`, `part/content`, `part/type`) | the cached WSDL and its imports, keyed by URL. `content` holds the document either inline as XML or as text |
| `interface/endpoints/endpoint` | interface endpoint URLs |
| `interface/operation` (`@name`, `@action`, `@bindingOperationName`) | a binding operation |
| `operation/call` | a saved request. `@name`, `endpoint`, `request` (the envelope, optionally with a `@compression` attribute), `encoding`, `@timeout`, `credentials/username`, `credentials/domain`, `credentials/password`, `@useWsAddressing` |
| `environment` (`@name`, `property`, `service/@name` + `service/endpoint`) | an environment with its property values and endpoint overrides |
| every element whose local name ends in `Script` | a script (`@language` when given) |

Anything else is left alone and, where it holds user work (the list in ruling 3), named in the report.

## 4. Mapping

- **Definitions.** Each interface is resolved through the normal WSDL import, with a document fetcher that
  answers from the file's `definitionCache` parts by URL. So an interface imports offline, exactly as it was
  when the file was last saved. When an interface has no cache, the fetcher falls back to the network for
  `@definition`, and the report says so, but only over `http(s)`: a `file:` location the imported file names is
  never read. When neither works, the interface is skipped with the reason.
- **Endpoints.** Endpoint URLs become the interface's `Endpoint`s. The first becomes the default.
- **Requests.** Each `call` becomes a `SoapRequestDef` under its operation (matched by binding and
  operation name), keeping its name and its envelope byte for byte. A call's endpoint that is one of the
  interface's endpoints is referenced by id; any other becomes `endpointUrl`. `encoding` and `@timeout`
  map to request properties. An operation that no longer exists in the definition keeps its requests,
  marked `orphaned`, as Update Definition does. An operation with no calls gets no generated request. What
  the file had is what arrives.
- **Credentials.** A username (and domain, which turns the type into `ntlm`) is kept. Passwords are never
  written to the project (ADR-0004). Every request or endpoint that had one is listed in the report, to be
  re-entered.
- **Properties.** Project properties merge into the project's properties. A name that already exists keeps
  its current value and is reported. Environments become Wirebench environments with their property values
  and their per-interface endpoint overrides (keyed by the imported interface's slug). An environment whose
  name already exists gets a numbered name. A project environment only takes effect through the workspace
  environment of the same slug, and only workspace environments can be switched to, so the import adds any
  workspace environment that is missing, with a note in the report.
- **Scripts.** Written to `imported-scripts/<owner-path>/<element>.<ext>` (`.groovy` by default or
  `.js` for `javascript`). `<owner-path>` is the slugified chain of named owners, and a clash gets a
  numeric suffix.
- **Compressed envelopes.** A `request` with `@compression` set is decoded as base64 gzip. When that fails,
  the request is skipped and reported.

## 5. The import report

`LegacyImportReport` lists counts (interfaces, operations, requests, environments, properties, scripts) and
`items: { severity: 'info' | 'warning'; path: string; message: string }[]`. `path` is the element's owner
chain, e.g. `Billing › getInvoice › Request 2`. The dialog shows the counts and the items, and the items can
be copied as text.

## 6. Architecture

### 6.1 Engine, `packages/engine/src/soap/legacy-project/`

- `format.ts`: namespace URI and root name, plus `looksLikeLegacyProject(text)` for detection (exempt file).
- `model.ts`: the typed, parsed file (`LegacyProject`, `LegacyInterface`, `LegacyOperation`, `LegacyCall`,
  `LegacyScript`, `LegacyEnvironment`).
- `parse.ts`: xmldom parse via `xml/parse.ts` (no DTDs, no external entities) into the model. Tolerant of
  missing optional elements; collects unknown top-level user-work elements for the report.
- `definition-fetcher.ts`: `fetchDocumentFromCache(cache, { fallback, onFallback })` implementing `FetchDocument`.
- `import.ts`: `readLegacySoapProject(source)`, which applies the 50 MB cap and parses. It throws
  `LegacyProjectError` (`legacy-too-large`, `legacy-read-failed`, `legacy-malformed`, `legacy-not-a-project`, `legacy-encrypted`).
- `map.ts`: pure functions from the parsed file plus each interface's resolved operations to `Interface`,
  `Environment`, properties, script files and the report. It is pure, so it can be unit-tested without a
  project host.

### 6.2 Detection

`import-detect.ts` gains kind `legacy-soap-project`. It is `definite` when the root element and namespace
match, and never probable from the file name alone (the extension is `.xml`).

### 6.3 Desktop

- `EngineService.importForProject` accepts an optional main-side `fetchDocument`. It never crosses IPC.
- `ProjectHost.importLegacyProject(parsed)` resolves each interface, adds interfaces, requests,
  environments and properties, writes the script files, saves once, and returns the report.
- IPC `project.importLegacy`: `{ source: { kind: 'file', path }, target: { projectId } | { newProjectName } }`,
  answering `{ projectId, project, report, reportText }`. The path goes through `checkedImportSource` like every
  other import, and the file is parsed before any project is created. An empty `newProjectName` takes the name
  the file gives the project. A new project is removed again when the import fails, as with Postman.
- `project.addInterface` checks the head of a picked file and refuses a legacy project with
  `legacy-project-as-wsdl`, naming the format to choose, instead of failing partway through a WSDL import.
- Renderer: no dialog of its own. The unified Import dialog gains the _Legacy SOAP project_ format (detected
  from dropped or pasted text, and offered in the format list) and a summary with counts, warnings, notes and a
  Copy report button. The command palette's `definition.importLegacyProject` opens it on that format. The
  project is read from the picked file, so a dropped or pasted copy is refused with "use Browse…".

## 7. Boundaries

- Never run, translate or evaluate a script.
- Never write a password to disk. Never fetch from the network when the file's cache answers.
- Never name the originating product in UI text, docs or commit messages.
- No change to the Wirebench project format: `imported-scripts/` sits outside what the loader and saver
  manage.

## 8. Verification

- Engine unit tests per module against hand-written fixtures in `fixtures/legacy-soap-project/`:
  minimal, multi-interface with a two-part cached WSDL, no cache, compressed request, scripts, credentials,
  test suites and mocks present (reported, not mapped), and malformed.
- Detection tests. A desktop main test for `importLegacyProject` against a temporary project folder.
  Renderer test for the dialog. e2e: import the multi-interface fixture and see its requests in the
  explorer (CI).

## 9. Success criteria

- The multi-interface fixture imports offline, with every call present under the right operation and its
  envelope unchanged.
- Every skipped item and every dropped password is in the report.
- `pnpm check` is green, with the banned-terms exemption limited to the two paths in ruling 5.
