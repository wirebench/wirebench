# GraphQL queries and mutations — Implementation Plan

> Steps use `- [ ]`. One commit per task, after `WIREBENCH_SKIP_PERF=1 pnpm check` is green.

**Goal:** A REST request can carry a GraphQL body, with a stored schema, editor assistance, response
checks as Problems and a failing run check on `errors`.

**Spec:** docs/specs/2026-10-13-graphql-client-design.md

## Global constraints

- New dependencies: `graphql` (engine) and `graphql-language-service` (desktop main only). Run
  `pnpm licenses:third-party` after adding them.
- No renderer value import of `graphql`, of the engine root, or of zod wire modules in eagerly loaded code.
- New persisted fields are optional and omitted when unset (saves stay byte-identical).
- Project format 11. Run `tsc -b` before `pnpm schemas:project`.
- IPC channel names are pinned in `ipc-names.json`.
- Run `pnpm --filter desktop build` after touching main-process strings.
- Commits are made as Mohammed Naami, with no trailers. Never name another product as the inspiration.

---

### Task 1: The GraphQL body in the model and on disk

**Files:** `packages/engine/src/rest/{model,files,storage}.ts`, `project/model.ts` (format 11), and tests.

- [ ] `RestBody` gains `{ kind: 'graphql'; query: string; variables: string; operationName?: string }`.
- [ ] Files schema arm `{ kind: 'graphql', file, variables?, operationName? }`, where `file` is a path segment.
  Load reads the sibling file; a missing file is a `missing-body` problem with an empty query.
- [ ] Save writes `<slug>.body.graphql`, and writes `variables` only when it is not blank.
- [ ] `FORMAT_VERSION = 11`, with the history note. The v11 JSON Schemas are generated, and v10 goes back to its released content.
- [ ] Tests: a round trip, the sibling file name, empty variables omitted, a missing file, and a path-traversal file refused.

### Task 2: Expansion and lowering to JSON

**Files:** `rest/expand.ts`, new `rest/graphql/body.ts`, `rest/body.ts`, `rest/secrets.ts`, and whatever
else `tsc` names (header preview, cURL, code generation, exports).

- [ ] `graphqlPayload(body) → string`, which throws `graphql-variables-invalid` when the variables do not parse.
- [ ] `expandBody` expands the query and operation name as written and the variables with JSON escaping, then
  returns the lowered `raw`/`json` body.
- [ ] `encodeRestBody` lowers a graphql body too, and `bodyLanguage` gives `json`.
- [ ] The secret scan and secret moves cover the query and the variables.
- [ ] Every other exhaustive switch lowers the body. The Postman export is Task 5.
- [ ] Tests: lowering, blank variables, an operation name, references in each part, escaping on and off,
  invalid variables, the secret scan.

### Task 3: Stored schema

**Files:** new `rest/graphql/schema.ts`, `rest/model.ts` (`RestApi.graphqlSchema`), `rest/files.ts`,
`rest/storage.ts`, the `index.ts` and `rest` subpath exports, and tests.

- [ ] `INTROSPECTION_QUERY`, `sdlFromIntrospection(json)`, `sdlFromSchemaFile(text, fileName)`,
  `readGraphqlSchema(projectDir, apiSlug)` and `writeGraphqlSchema(...)`.
- [ ] `graphqlSchema` persisted in `api.yaml`.
- [ ] Tests: introspection with and without the `data` wrapper, SDL that is valid and invalid, a JSON file
  holding errors, a round trip.

### Task 4: Response check and the run check

**Files:** new `rest/graphql/check.ts`, `rest/run.ts`, `run/run.ts` (`SentRequest.checks`),
`assert/model.ts` (`AssertionResult.type` gains `graphql`), `protocols.ts` (`SentExchange.rest.graphql`),
and tests.

- [ ] `checkGraphqlResponse({ schema?, query, operationName?, bodyText })` returns `{ checked, errors[], problems[] }`.
- [ ] REST's send attaches the result to the exchange when the request body was GraphQL. It reads the
  schema once per run through `scope.memo`.
- [ ] The run loop adds `sent.checks`: a failed "GraphQL errors" check, which `unasserted` does not count.
- [ ] Tests: errors with paths, a missing field, null in a non-null field, the wrong scalar, a list, aliases,
  fragments, no schema, a body that is too large, and a run that fails on errors with HTTP 200.

### Task 5: Imports and Postman export

**Files:** `import/opencollection/map.ts`, `import/http-file/map.ts`, `rest/postman/{parse,map}.ts`,
`export/postman.ts`, and tests.

- [ ] Each one maps to the GraphQL body, and the #77 notes are removed. The `.http` `GRAPHQL` request becomes a POST
  with the GraphQL body. Postman export writes `mode: graphql`.

### Task 6: Desktop wire, mutations and summary

**Files:** `shared/kinds/rest/wire.ts`, `main/project-wire.ts`, `main/kinds/rest/mutations.ts`,
`main/send/record.ts` (`summariseRest`), and tests.

- [ ] A body wire arm, `graphqlSchema` on the API wire, and `graphql` on the REST exchange summary and History.
- [ ] `toEngineBody` and `toRestBodyWire` handle the new arm.

### Task 7: Desktop main channels

**Files:** `shared/kinds/rest/channels.ts`, `main/kinds/rest/{ipc,host}.ts`, new
`main/kinds/rest/graphql-assist.ts`, `ipc-names.json`, and tests.

- [ ] `request.graphqlIntrospect({ requestId, draft? })` sends without recording and writes the SDL plus the API field.
- [ ] `api.importGraphqlSchema({ apiId })` uses main's picker. `api.clearGraphqlSchema({ apiId })` removes the schema.
- [ ] `request.graphqlAssist(...)` gives completions, diagnostics, hover and variable completions, with
  the built schema cached per API.

### Task 8: Renderer body editor

**Files:** `renderer/features/rest-editor/body-tab.tsx`, new `graphql-body.tsx`,
`renderer/editor/graphql-language.ts` (grammar registration and providers), and tests.

- [ ] A GraphQL kind with the query and variables editors, the schema toolbar and the operation picker.
  Switching to it turns a GET or HEAD request into a POST.

### Task 9: Response chip, Problems and the explorer

**Files:** `rest-editor/response/{response-pane,body-view}.tsx`, new `response/graphql.ts(x)`,
`renderer/kinds/rest/explorer*.ts(x)`, and tests.

- [ ] The chip, the markers and the Problems rows (`graphql` source). The `GQL` badge, and *New GraphQL request*.

### Task 10: e2e, docs and changelog

- [ ] An e2e spec against the fixture server's GraphQL endpoint (add a tiny one if none exists).
- [ ] The docs-site page for GraphQL requests, the project-format reference (format 11), `CHANGELOG.md` and the roadmap item 17.
