# Wirebench: contract diff and breaking-change report — design

Date: 2026-10-08 · Status: design, written from the issue and the code; open points in §9 · Issue #56
(roadmap item 9, milestone 5.0)

- Builds on:
  - Update Definition's change report: `planUpdate` (`wsdl/update-definition.ts`) and `planRestUpdate`
    (`rest/openapi/update.ts`). They decide which operations were added, removed or changed, and
    which `soap:address` locations moved. They do not say _what_ changed inside an operation, and
    they do not say whether a change breaks a client.
  - The XSD → JSON Schema bridge of the MCP contract tools (#33): `operationJsonSchema(input, op,
direction)` (`soap/json-operation.ts`) writes a SOAP operation's request or response body as
    JSON Schema. Element occurrence, `use="required"`, enumerations and facets all come out as JSON
    Schema keywords. So both WSDL and OpenAPI can be compared by **one** JSON Schema differ.
  - The CLI's source reading (`ops/import.ts`: a path or an `http(s)` URL, proxy from the
    environment) and the project definition caches (`readWsdl`, `readOpenApi` in `ops/project.ts`).

## 1. Goal

Two versions of a WSDL, or two versions of an OpenAPI document, are compared operation by operation.
Each difference is one **change** with a location and a sentence, classified **breaking** or
**compatible** for an existing client. The report is printed, exported as Markdown and HTML (and JSON),
and `wirebench diff-contract` fails a CI job when a breaking change is found.

Out of scope here: AsyncAPI and gRPC; OpenAPI webhooks and callbacks; SOAP faults and headers; the
desktop (Update Definition's dialog could show the same classification later — §9).

## 2. Model (engine core, `contract-diff/model.ts`)

```ts
type ChangeSeverity = 'breaking' | 'compatible';

type ContractChangeKind =
  | 'operation-added' | 'operation-removed'
  | 'endpoint-added' | 'endpoint-removed' | 'endpoint-moved'
  | 'field-added' | 'field-removed' | 'field-required' | 'field-optional'
  | 'type-changed' | 'type-narrowed' | 'type-widened'
  | 'enum-values-added' | 'enum-values-removed'
  | 'constraint-narrowed' | 'constraint-widened' | 'constraint-changed'
  | 'media-type-added' | 'media-type-removed'
  | 'response-added' | 'response-removed'
  | 'soap-action-changed' | 'soap-version-changed' | 'style-changed' | 'security-changed';

interface ContractChange {
  readonly kind: ContractChangeKind;
  readonly severity: ChangeSeverity;
  /** `Binding#Operation` (WSDL) or `METHOD /path` (OpenAPI); absent for a contract-wide change. */
  readonly operation?: string;
  /** Where inside the operation: `request.body.order.items[].sku`, `request.query.limit`, `response.200`. */
  readonly location?: string;
  /** One sentence: what was, what is. */
  readonly message: string;
}

interface ContractDiff {
  readonly format: 'wsdl' | 'openapi';
  readonly old: ContractSide;            // { label, title?, version? }
  readonly new: ContractSide;
  readonly operationsCompared: number;   // operations both sides have
  readonly changes: readonly ContractChange[];  // breaking first, otherwise in contract order
  readonly notes: readonly string[];     // what could not be compared (unresolved types, …)
}
```

`summarize(diff)` gives `{ breaking, compatible }` counts.

## 3. What is compared

### 3.1 Operations and endpoints

- Operation identity is the one Update Definition uses, so both features agree: `{ns}Binding#Operation`
  for WSDL, `method path` for OpenAPI. A renamed binding or path is a removal plus an addition.
- `operation-removed` breaking; `operation-added` compatible.
- Endpoints are the `soap:address` locations (WSDL) or the document's `servers` URLs (OpenAPI).
  When exactly one is removed and one added, it is one `endpoint-moved` (breaking). Otherwise each
  removed one is `endpoint-removed` (breaking), each added one `endpoint-added` (compatible).
- WSDL per operation: `soap-action-changed`, `soap-version-changed`, `style-changed` — all breaking.
- OpenAPI per operation: the effective security (the operation's, else the document's) differs →
  `security-changed`, breaking.

### 3.2 Messages as JSON Schema

Each operation has a **request** and a **response** side. A side is a tree of JSON Schema:

- WSDL: `operationJsonSchema(…, 'request')` and `(…, 'response')`, with their `$defs`.
- OpenAPI request: a field per parameter at `request.<in>.<name>` (its `required`, its `schema`), and
  the request body per media type at `request.body` (the JSON media type; else each media type by
  name). OpenAPI response: per status key at `response.<status>`, each JSON media type's schema.

### 3.3 Classification

Who is hurt depends on the side: the client **writes** the request and **reads** the response. So
narrowing what the server accepts breaks the request side, and widening what the server may send
breaks the response side.

| Change                                                       | Request side | Response side |
| ------------------------------------------------------------ | ------------ | ------------- |
| field added, required                                        | breaking     | compatible    |
| field added, optional                                        | compatible   | compatible    |
| field removed                                                | breaking     | breaking      |
| field made required (`field-required`)                       | breaking     | compatible    |
| field made optional (`field-optional`)                       | compatible   | breaking      |
| type narrowed (`number`→`integer`, a type left a union, …)   | breaking     | compatible    |
| type widened (the reverse)                                   | compatible   | breaking      |
| type changed (neither contains the other)                    | breaking     | breaking      |
| enumeration values removed (or an enumeration introduced)    | breaking     | compatible    |
| enumeration values added (or the enumeration dropped)        | compatible   | breaking      |
| constraint narrowed (min up, max down, pattern set/changed…) | breaking     | compatible    |
| constraint widened (the reverse, a pattern dropped)          | compatible   | compatible    |
| media type removed                                           | breaking     | breaking      |
| media type added                                             | compatible   | compatible    |
| response removed (a 2xx status, or `default`)                | —            | breaking      |
| response removed (any other status)                          | —            | compatible    |
| response added                                               | —            | compatible    |

Notes on the rules:

- **Field removed is breaking on the request side** too: a client still sending the field is
  refused when the object does not allow other properties, and silently ignored otherwise; either way
  the client's intent is lost.
- **Constraints**: `minLength`, `maxLength`, `minimum`, `maximum`, `exclusiveMinimum`,
  `exclusiveMaximum`, `minItems`, `maxItems`, `pattern`, `format`. A changed pattern counts as
  narrowed (it cannot be proved wider). Known widening formats: `int32`→`int64`, `float`→`double`.
- **XML occurrence** (WSDL only): a single element becoming repeating (`maxOccurs` 1→n, an object or
  value becoming an array of it) is a widening, because one element is still valid XML for a
  repeating particle; n→1 is a narrowing. In JSON (OpenAPI) a value becoming an array is
  `type-changed`.
- `null` is part of the type: OpenAPI 3.0 `nullable: true` reads as `type: [..., 'null']`.
- `oneOf`/`anyOf`/`allOf` options equal on both sides are matched wherever they sit, so a reordering
  is no change; the rest are compared by position. An option added or removed is a type widening or
  narrowing of that node. A changed bare rule (an option with no type of its own, as an XSD choice's
  branch rules are) is `constraint-changed`, breaking on both sides: whether it allows more or less
  cannot be told.
- **Recursion**: `$ref`s into `$defs` (WSDL) and cyclic resolved schemas (OpenAPI) are followed; a
  pair of nodes met again on the path being compared is a cycle and is not compared again. A schema
  shared by several fields is compared at each of them. One diff compares at most 50 000 nodes; past
  that it stops and says so in `notes`.
- Descriptions, titles, examples and documentation keywords of a schema are not compared (a property
  of that name is).

## 4. Engine API

- Core, `packages/engine/src/contract-diff/`:
  - `model.ts` (§2), `schema-diff.ts` (`diffSchemas(old, new, { side, location, operation, xmlOccurrence })`
    → `ContractChange[]`), `endpoints.ts` (§3.1 endpoint rule), `render.ts`
    (`renderContractDiffMarkdown(diff)`, `renderContractDiffHtml(diff, tool)`), `index.ts`.
- `wsdl/contract-diff.ts` (soap group): `diffWsdlContracts(old: WsdlImportResult, next:
WsdlImportResult, labels): ContractDiff` — added and removed operations and endpoints from
  `planUpdate`, then per common operation the transport checks and the two JSON Schema sides.
- `rest/openapi/contract-diff.ts` (rest group): `diffOpenApiContracts(old: OpenApiDocument, next:
OpenApiDocument, labels): ContractDiff` — added and removed operations from `planRestUpdate`, then
  per common operation security, parameters, body and responses.
- All exported from the engine index. Core imports no protocol folder (`pnpm check:engine-layers`).

## 5. Reports

- **Markdown**: a title, the two sides (label, title, version), a summary line (`2 breaking, 5
compatible changes in 7 operations compared`), then a `## Breaking changes` and a `## Compatible
changes` section, each a table `| Operation | Location | Change |`. Cells are escaped (`|`, backticks,
  newlines). No changes → one line saying the contracts are equivalent.
- **HTML**: one self-contained page, the run report's look (inline CSS, light and dark variables, no
  script), the same sections; every text is HTML-escaped.
- **JSON**: the `ContractDiff` object, with `summary`.

## 6. CLI: `wirebench diff-contract`

```
wirebench diff-contract <old> <new> [--fail-on breaking|any|none]
                        [--reporter markdown=<file>|html=<file>|json=<file>]… [--project <dir>]
                        [-q]
```

- `<old>` and `<new>` are each a file path, an `http(s)` URL, or `project:<name>` — the cached
  definition of the project's interface or REST API of that name (or slug), read from `--project`
  (default `.`) with no network access. A CI job can then check a freshly built contract against the
  one the project was built from.
- Both must be the same format (detected as `wirebench import` detects it); otherwise exit 2
  (`contract-formats-differ`). An AsyncAPI, gRPC or unknown document is `unsupported-format` (exit 2).
- stdout: a text summary — one line per change, `BREAKING` / `compatible`, operation, location,
  message — and the counts. `-q` prints the counts only. `--reporter` writes the files (repeatable).
- Exit codes: 0 when the gate passes; **1** when it fails (`--fail-on breaking`, the default: any
  breaking change; `any`: any change; `none`: never); 2 for usage, an unreadable file or a missing
  cache; 3 for a fetch or parse failure.
- The import problems of either side (an unresolved import, a skipped construct) go to stderr as
  warnings and into `notes`; they do not change the exit code.

## 7. Proof

- Engine unit tests for `diffSchemas` over every §3.3 row, both sides, recursion, `$defs`, nullable,
  XML occurrence; for the endpoint rule; for each adapter over new fixture pairs
  (`fixtures/wsdl/crafted/contract-diff/{v1,v2}.wsdl`, `fixtures/openapi/crafted/contract-diff/{v1,v2}.yaml`)
  that hold one of each issue checklist change (operation added and removed, element made required,
  type narrowed, enumeration changed, endpoint moved); for the renderers (escaping, empty diff).
- CLI unit tests: argument parsing, exit codes for each `--fail-on`, `project:` sources, reporter
  files, mixed formats.
- No e2e: the desktop does not change.

## 8. Docs

- `docs/cli.md` gains a `## Contract diff` section; the exit-code table gains the verb.
- The site's CLI page, the CHANGELOG (Unreleased → Added), and the roadmap (item 9 shipped) are updated.

## 9. Open points (defaults taken, owner may overturn)

1. **Desktop.** Update Definition's dialog keeps its per-operation reasons; showing the breaking
   classification there (and an "Export report" button) is a follow-up.
2. **Field removed on the request side is breaking** (§3.3) — a stricter reading than "ignored
   properties are harmless".
3. **Enumeration value added on the response side is breaking** — a client switching over the values
   meets one it does not know.
4. **Webhooks, callbacks, SOAP faults and headers** are not compared in this slice.
