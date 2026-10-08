# Plan: Mock services (engine, PR 1)

Spec: [`docs/specs/2026-10-08-mock-services-design.md`](../specs/2026-10-08-mock-services-design.md)
ADR: [`docs/adr/0021-mock-stubs-are-files-under-mocks.md`](../adr/0021-mock-stubs-are-files-under-mocks.md)
Issue: [#59](https://github.com/wirebench/wirebench/issues/59)

> **For agentic workers:** REQUIRED SUB-SKILL: use superpowers:subagent-driven-development
> (recommended) or superpowers:executing-plans to carry out this plan task by task. Steps use
> checkbox (`- [ ]`) syntax for tracking.

**Goal:**
- A project can hold mock services under `mocks/`.
- The engine generates a mock from an interface's or API's cached contract, and serves it over HTTP.
- The engine validates each request against that contract, and dispatches by sequence, random, match or
  script, with scenarios.
- All of it works on plain Node, with no desktop. PR 2 (the desktop) follows on its own plan, and closes #59.

**Architecture:**
- **Core `mock/`:**
  - `model.ts` and `file.ts`: the files;
  - `load.ts`: `readMocks`, wired into `loadProject`, `projectFiles` and save;
  - `dispatch.ts`: candidates, sequence, random, match and scenarios;
  - `script.ts`: dispatch scripts on the ADR-0016 sandbox;
  - `server.ts`: `startMock` on `node:http`;
  - `generate.ts`: `generateMock`.
- **Protocol side.** `protocol/module.ts` gains the optional `mock` facet, with the `MockContract` types in
  `mock/contract.ts`.
- **SOAP.** `soap/mock.ts` routes, validates (`validateMessage`), builds faults, serves the WSDL
  (`soap/mock-wsdl.ts`) and generates output samples (`buildSampleMessage`).
- **REST.** `rest/mock.ts` routes (`matchOperation`), validates (the new `rest/request-check.ts`), builds
  problem+json replies and generates from response examples and schemas.

**Tech stack:** TypeScript (ESM, `.js` import suffixes), zod 4, vitest, `node:http`, the QuickJS sandbox.

## Global constraints

- **Gate before every commit:** `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 pnpm check`.
  `pnpm test:perf` before the push.
- No local Electron windows; CI runs e2e. Run focused tests with
  `nice pnpm --filter @wirebench/engine exec vitest run <file>`.
- **Commits:** one per task after the gate is green, as Mohammed Naami <m.naami@outlook.com>, with no
  `Co-Authored-By:` or `Claude-Session:` trailer.
- **Product names:** never name the product that inspired a feature (`pnpm check:banned-terms`).
- **No new dependencies.**
- **Layers.** `mock/` is core and imports no protocol folder. Only `soap/`, `rest/` and the composition files
  name a protocol (`pnpm check:engine-layers`).
- **No `formatVersion` change.** `FORMAT_VERSION` stays 8, and a version-8 project with `mocks/` must save
  with its `wirebench.yaml` unchanged.
- **The script sandbox worker** loads from `dist/`, so a test that runs scripts needs `pnpm --filter
  @wirebench/engine build` first, as the existing script tests do.

## File map

| File | Change |
| --- | --- |
| `packages/engine/src/mock/model.ts` | new: `MockDef`, `MockOperation`, `MockResponse`, `MockMatch`, limits, `MOCK_VERSION` |
| `packages/engine/src/mock/file.ts` | new: schemas, parse and serialise for the three file kinds |
| `packages/engine/src/mock/load.ts` | new: `readMocks` (loaded, problems, managed files) |
| `packages/engine/src/mock/contract.ts` | new: `MockRequest`, `MockRoute`, `MockReply`, `MockContract`, `ProtocolMocking` |
| `packages/engine/src/mock/dispatch.ts` | new: candidates, styles, match conditions, scenario state |
| `packages/engine/src/mock/script.ts` | new: the dispatch prelude and run |
| `packages/engine/src/mock/server.ts` | new: `startMock`, `RunningMock`, `MockExchangeEvent` |
| `packages/engine/src/mock/generate.ts` | new: `generateMock` |
| `packages/engine/src/mock/index.ts` | new: barrel |
| `packages/engine/src/project/{model,load,serialize,save}.ts` | `Project.mocks`, problems, files, managed and conflict |
| `packages/engine/src/protocol/module.ts` | optional `mock` facet |
| `packages/engine/src/soap/request-builder.ts` | `buildSampleMessage(…, 'input' \| 'output')` |
| `packages/engine/src/soap/mock.ts`, `soap/mock-wsdl.ts`, `soap/module.ts` | SOAP facet |
| `packages/engine/src/rest/request-check.ts` | new: request validation against an OpenAPI operation |
| `packages/engine/src/rest/mock.ts`, `rest/module.ts` | REST facet |
| `packages/engine/src/index.ts` | exports |
| `scripts/engine-import-graph.mjs` | only if a new core exception is unavoidable (aim: none) |
| `docs-site/.../reference/project-format.md`, `docs/security.md`, `docs/roadmap.md`, `CHANGELOG.md` | docs |

---

### Task 1: Spec, plan and ADR

- [ ] Spec, this plan, ADR-0021 and the ADR-0003 update.
- [ ] Gate, then commit `docs: mock services spec, plan and ADR-0021 (#59)`.

### Task 2: The mock files

- [ ] `mock/model.ts`:
  - the types from the spec;
  - `MOCK_VERSION = 1`;
  - `MOCK_LIMITS` (file and body sizes, counts, `delayMs`);
  - `SCENARIO_NAME`;
  - `createMock`, `createMockOperation` and `createMockResponse`.
- [ ] `mock/file.ts`:
  - `mockFileSchema`, `operationFileSchema` and `responseFileSchema`, each a `looseObject`;
  - `parseMockFile`, `parseOperationFile` and `parseResponseFile`, with the size first, then the YAML, then
    `kind` and `version`, then zod;
  - header refusals: CR, LF or NUL, and the hop-by-hop names;
  - `mockFiles(mock)`, giving path → text for every file;
  - body extension by language.
  - Every parse throws `ProjectError` `mock-file-invalid` or `mock-version-too-new` with `details.file`.
- [ ] Tests (`test/unit/mock/file.test.ts`):
  - round-trip and deterministic output;
  - every limit, a too-new version, and a bad header;
  - unknown keys are dropped;
  - a body by language, and `none`.
- [ ] Gate, then commit `feat(engine): mock service files (#59)`.

### Task 3: Load and save mocks with the project

- [ ] `mock/load.ts` `readMocks(fs, root)`: `{ loaded: { dir, files, mock }[], problems }`.
  - A bad `mock.yaml` skips the mock.
  - A bad operation or response file skips only that file.
  - Duplicate mock ids load the first by directory name.
  - A dangling `default` is a problem and is dropped.
  - A missing body is a problem and loads as empty.
  - The total-body cap applies.
- [ ] `Project.mocks` (`createProject` → `[]`). `loadProject` adds the `mock-*` problems. `projectFiles`
  writes `mockFiles`, with `assertPathSegment` on every slug.
- [ ] `save.ts`: `listManagedFiles` adds the loaded mocks' files. Add `refuseOverwritingForeignMocks`
  (`mock-file-conflict`).
- [ ] Tests (`test/unit/mock/load-save.test.ts`):
  - load, save, and pruning a removed response's two files;
  - a refused file surviving a save;
  - the conflict;
  - a version-8 project with `mocks/`, opened and saved, with `wirebench.yaml` byte-identical.
- [ ] Gate, then commit `feat(engine): load and save mocks with the project (#59)`.

### Task 4: The contract types and dispatch

- [ ] `mock/contract.ts`:
  - `MockRequest` (method, path, query, headers, body bytes and text);
  - `MockRoute` (operation key?, problems, refused?, match view: `body`, `language`, `query`, `headers`,
    `pathParams`);
  - `MockReply`, `MockContract` and `ProtocolMocking`.
- [ ] `ProtocolModule.mock?: ProtocolMocking`, passed through by `defineProtocol`.
- [ ] `mock/dispatch.ts`:
  - `MockState`: scenario states (default `Started`), sequence counters, and `reset()`;
  - `candidates(op, state)`;
  - `pickResponse(op, route, state, { random, evaluate, script })`, which is async for match and script and
    commits synchronously;
  - `evaluateMatch` (body via `evaluateWithTimeout` with the request's prefixes; `matches` via
    `matchRegexWithTimeout`; failures become `mock-match-failed` problems);
  - the `default` fallback, `mock-no-stub` and `mock-no-response`;
  - applying `scenario.next`.
- [ ] Tests (`test/unit/mock/dispatch.test.ts`):
  - each style, each match source and check;
  - scenario filtering and `next`;
  - the fallbacks;
  - two concurrent picks taking two slots;
  - a catastrophic regex not blocking a timer.
- [ ] Gate, then commit `feat(engine): mock dispatch and scenarios (#59)`.

### Task 5: Script dispatch

- [ ] `mock/script.ts`:
  - the prelude, which installs `request`, `scenarios`, `responses`, `respond`, `log`, `crypto` and
    `encoding` (the last two reuse the request-script host functions);
  - `runDispatchScript(sandbox, source, input)` → `{ response?, scenarios, log } | { error }`;
  - types are stripped with `script/strip.ts`, and the request body is cut to 1 MiB.
- [ ] Wire `dispatch: script` into `pickResponse`. The script is read in `readMocks` (≤ 256 KiB).
- [ ] Tests (`test/unit/mock/script.test.ts`): `respond`, `scenarios.get` and `set`, an unknown name,
  `respond` never called, a timeout and a throw.
- [ ] Gate, then commit `feat(engine): dispatch a mock operation with a script (#59)`.

### Task 6: The mock server

- [ ] `mock/server.ts` `startMock(input)`:
  - **Lookup.** It resolves the mock and the container, and `registry.find(kind)?.mock` (otherwise
    `mock-protocol-unsupported`), then calls `facet.open()`.
  - **Warnings.** An operation whose key the contract lacks gets `mock-operation-unknown`.
  - **The listener.** `node:http` on the host (default `127.0.0.1`) and port, with 30 s header and request
    timeouts. An open port fails with `mock-port-in-use`.
  - **Per request:**
    - the `Host` check (421);
    - a body over 10 MiB is 413 (`mock-request-too-large`);
    - then `definition`, `route`, `refuse` or dispatch, then `delayMs`, then the reply.
  - **The log.** Every request emits a `MockExchangeEvent`, with headers masked through `redactHeaderPairs`
    and bodies cut to 64 KiB.
  - **`reset()` and `stop()`.** `stop()` closes the server, destroys the sockets, clears the pending delays,
    and disposes of a sandbox the mock created itself.
- [ ] Tests (`test/unit/mock/server.test.ts`), with a fake facet in a custom registry:
  - routing to dispatch;
  - the Host check, the 413, `delayMs`, and `stop()` with a keep-alive connection;
  - port in use;
  - the event's masking and truncation;
  - a gRPC container refused.
- [ ] Gate, then commit `feat(engine): serve a mock over HTTP (#59)`.

### Task 7: SOAP samples for responses

- [ ] `buildSampleMessage(input, op, direction, genOptions?, options?)` in `request-builder.ts`, where
  `'output'` uses the output message, the output body and headers, and the `<op>Response` RPC wrapper.
  `buildSampleRequest` delegates with `'input'`, so its behaviour is unchanged.
- [ ] Tests: document/literal and RPC output samples; a one-way operation reports no output. The existing
  request-builder tests stay green.
- [ ] Gate, then commit `feat(engine): generate a SOAP response sample (#59)`.

### Task 8: The SOAP facet

- [ ] `soap/mock.ts`:
  - **`open`.** It reads the definition cache offline (otherwise `mock-definition-missing`), finds the binding
    (otherwise `mock-binding-unknown`), and maps the operations.
  - **`route`.** It refuses a `<!DOCTYPE` and checks the version against the `Content-Type`. It routes by
    SOAPAction, then by the body QName, and records a disagreement. It validates with
    `validateMessage({ direction: 'request' })`. It exposes the body as `xml` for match.
  - **Replies.** `refuse` and `fail` build 1.1 or 1.2 faults with `urn:wirebench:mock` problem details (at
    most 20). `defaults` gives the version's `Content-Type`.
  - **`generate`.** It picks the binding (the first SOAP binding, 1.1 preferred, or the one named) and
    builds one `Default` response per operation (202 and `none` for one-way).
- [ ] Register `mock` on `soapProtocol`.
- [ ] Tests (`test/unit/soap/mock.test.ts`), over HTTP with `startMock` and a fixture WSDL:
  - routing three ways;
  - `reject`, `report` and `off`;
  - the 1.1 and 1.2 faults;
  - a 415;
  - a DTD refused;
  - match by XPath.
- [ ] Gate, then commit `feat(engine): SOAP mock services (#59)`.

### Task 9: Serving the WSDL

- [ ] `soap/mock-wsdl.ts`:
  - `definitionReply(bundle, request, mockUrl)` serves `?wsdl`, `?wsdl=<n>` and `?xsd=<n>`;
  - in the served document, the addresses are rewritten, and so are the imports and includes that resolve
    to bundle documents;
  - it uses DOM edits with the engine's XML parser and serialiser.
- [ ] Tests: a fixture with an imported WSDL and an included XSD. Fetch `?wsdl` and follow every rewritten
  location: each serves; each address is the mock's; nothing outside the bundle can be named.
- [ ] Gate, then commit `feat(engine): a SOAP mock serves its WSDL (#59)`.

### Task 10: REST request validation

- [ ] `rest/request-check.ts` `checkRestRequest({ operation, pathParams, query, headers, cookies,
  contentType, bodyText })` → problems `{ in, name?, path, message }`:
  - required parameters;
  - `form`-style primitive and array conversion, then `validateJsonSchema`;
  - another style is checked only for presence;
  - a required body;
  - media type matching (otherwise a `415` marker);
  - a JSON body against its schema, with `redactValues: true`.
  - It is bounded as `contract-check.ts` is.
- [ ] Tests (`test/unit/rest/request-check.test.ts`): each parameter location and type, arrays, a missing
  required value, 415, JSON body problems without values, and an unsupported style.
- [ ] Gate, then commit `feat(engine): validate a REST request against its operation (#59)`.

### Task 11: The REST facet

- [ ] `rest/mock.ts`:
  - **`open`.** It uses `loadOpenApiDocument` (otherwise `mock-definition-missing`).
  - **`route`.** It strips the mock path, uses `matchOperation`, and gives 404, or 405 with `Allow`. It
    extracts the path parameters, runs `checkRestRequest`, and exposes the body as JSON or text for match.
  - **Replies.** `refuse` and `fail` give problem+json. `defaults` gives the `Content-Type` by body language.
  - **`generate`.** It picks the lowest 2xx, or `default`, or 200. The body is the example, else
    `sampleFromSchema`, else `none`.
- [ ] Register `mock` on `restProtocol`.
- [ ] Tests (`test/unit/rest/mock.test.ts`), over HTTP: 404, 405, 415 and 400; `report` and `off`; match by
  JSONPath, query, header and path; generation from an example, from a schema, and with no content.
- [ ] Gate, then commit `feat(engine): REST mock services (#59)`.

### Task 12: `generateMock` and the engine surface

- [ ] `mock/generate.ts` `generateMock(project, root, containerId, { name, binding?, fs?, registry? })`.
  - It refuses with `mock-container-missing` and `mock-protocol-unsupported`.
  - It assigns slugs with `uniqueSlug` and ids with `generateId`.
- [ ] `mock/index.ts` barrel; the `index.ts` exports. `pnpm check:engine-layers` is green with no new
  exception.
- [ ] Test (`test/unit/mock/generate.test.ts`): generate, save, reload and start for a SOAP and a REST
  fixture, then send one request each and get the generated body back. This is the headless path #61 will
  use.
- [ ] Gate, then commit `feat(engine): generate a mock from an interface or API (#59)`.

### Task 13: Docs

- [ ] `reference/project-format.md`: the `mocks/` folder and its three files.
- [ ] `docs/security.md`: "Mock services".
- [ ] `docs/roadmap.md`: correct the "major because" sentence, and add the engine half of item 11.
- [ ] `CHANGELOG.md` (Unreleased).
- [ ] Open the follow-up issues from the spec.
- [ ] Gate, then commit `docs: mock services reference and security notes (#59)`.
