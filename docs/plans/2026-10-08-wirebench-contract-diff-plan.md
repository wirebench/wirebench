# Wirebench Contract Diff Implementation Plan

**Spec:** `docs/specs/2026-10-08-wirebench-contract-diff-design.md` (binding). Section numbers below are the spec's.

**Goal:** Two WSDLs or two OpenAPI documents compared per operation, each change classified breaking or
compatible, exported as Markdown, HTML and JSON, and gated in CI by `wirebench diff-contract`.

**Architecture:** one protocol-neutral core (`packages/engine/src/contract-diff/`: model, JSON Schema
differ, endpoint rule, renderers) fed by two thin adapters in their own protocol groups
(`wsdl/contract-diff.ts` over `planUpdate` and `operationJsonSchema`; `rest/openapi/contract-diff.ts`
over `planRestUpdate`). The CLI verb reads the sources the way `wirebench import` does, or a project's
definition cache, and maps the diff to an exit code.

## Global Constraints

- Branch `feat/56-contract-diff`. Commit as Mohammed Naami <m.naami@outlook.com>; no `Co-Authored-By`,
  no `Claude-Session` trailers.
- One commit per task after `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check`
  is green; `pnpm exec prettier --write <touched files>` first. `pnpm test:perf` once before the push.
- Core (`contract-diff/`) imports no protocol folder (`pnpm check:engine-layers`).
- Never name a product that inspired a feature (`pnpm check:banned-terms`).
- No e2e, no Electron windows; never bare `git stash`.

## Tasks

### Task 1 — Core model and JSON Schema differ

- `contract-diff/model.ts`: §2 types, `summarize`, `sortChanges` (breaking first, then operation, then
  location), the §3.3 severity table.
- `contract-diff/schema-diff.ts`: `diffSchemas(old, next, options)` with `$defs` resolution per root,
  type sets (`integer` ⊂ `number`, `nullable`), properties and `required`, `items`, enumerations,
  constraints, `format` widenings, combinators by position, XML occurrence, pair-visited recursion.
- `contract-diff/endpoints.ts`: `diffEndpoints(old, next)`.
- `contract-diff/index.ts`; exports in `src/index.ts`.
- Tests: `packages/engine/test/unit/contract-diff/schema-diff.test.ts`, `endpoints.test.ts` — every §3.3
  row on both sides, recursion (self-`$ref`, cyclic object), nullable, occurrence.

### Task 2 — WSDL adapter

- `wsdl/contract-diff.ts`: `diffWsdlContracts(old, next, labels)`; operation label `Binding#Operation`
  (local names); endpoints via `planUpdate`; soap action, version, style; request and response sides via
  `operationJsonSchema` with `xmlOccurrence: true`; schema notes into `notes`.
- Fixtures `fixtures/wsdl/crafted/contract-diff/v1.wsdl`, `v2.wsdl`: operation added and removed,
  element made required, type narrowed (`xs:decimal`→`xs:int`), enumeration value removed and one
  added in a response, `soap:address` moved, a soap action changed.
- Test: `packages/engine/test/unit/wsdl/contract-diff.test.ts`.

### Task 3 — OpenAPI adapter

- `rest/openapi/contract-diff.ts`: `diffOpenApiContracts(old, next, labels)`; operations from
  `planRestUpdate`; servers through `diffEndpoints`; per operation security, parameters (fields at
  `request.<in>.<name>`), request body (required, media types, JSON schema), responses (status keys,
  media types, JSON schemas).
- Fixtures `fixtures/openapi/crafted/contract-diff/v1.yaml`, `v2.yaml` with the same checklist changes.
- Test: `packages/engine/test/unit/rest/openapi/contract-diff.test.ts`.

### Task 4 — Renderers

- `contract-diff/render.ts`: `renderContractDiffMarkdown`, `renderContractDiffHtml(diff, tool)`,
  `contractDiffJson`. Self-contained HTML, escaped text, both themes.
- Test: `packages/engine/test/unit/contract-diff/render.test.ts` (escaping, empty diff, sections).

### Task 5 — `wirebench diff-contract`

- `args.ts`: the verb, `DiffContractArgs`, `--fail-on`, `--reporter markdown|html|json=<file>`,
  `--project`, `-q`; `HELP_TEXT` and `VERB_HELP`.
- `commands/diff-contract.ts`: read each source (path, URL through the import's fetcher, or
  `project:<name>` from the definition cache), detect the format, refuse mixed or unsupported formats
  (exit 2), diff, print, write reports, exit 0/1 per `--fail-on`.
- `ops/import.ts` exports `readSource` and `fetcherFor` for reuse.
- Tests: `packages/cli/test/unit/diff-contract.test.ts`, `args.test.ts` additions.

### Task 6 — Docs

- `docs/cli.md` `## Contract diff` and exit codes; site CLI page; CHANGELOG Unreleased → Added;
  roadmap item 9 shipped.
