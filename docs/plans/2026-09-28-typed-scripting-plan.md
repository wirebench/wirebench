# Typed scripting — plan

- **Spec:** `docs/specs/2026-09-28-typed-scripting-design.md` (issue #63). **ADR:**
  `docs/adr/0016-scripts-run-with-no-capabilities.md`, which extends ADR-0015.
- **Gate before every commit:** `NODE_OPTIONS=--max-old-space-size=8192 WIREBENCH_SKIP_PERF=1 nice pnpm check`.
  `pnpm test:perf` runs unskipped before a push.
- **Commits:** one per task, authored by Mohammed Naami <m.naami@outlook.com>, with no trailers.
- **Order:** the sandbox (Task 1) and its security rules (Task 2) land first, then the format, then types and the
  checker. Nothing runs a script from a project until Task 7, and by then every rule in ADR-0016 has its test.

## Task 1 — Engine: the sandbox

**Files**
- `packages/engine/package.json`: runtime dependencies `quickjs-emscripten-core` and
  `@jitl/quickjs-wasmfile-release-sync`, pinned. Regenerate `THIRD-PARTY-LICENSES.md` with
  `pnpm licenses:third-party`.
- `packages/engine/src/script/sandbox/worker.ts`:
  - loads the WASM module once per worker;
  - per job, creates a fresh runtime and context with `setMemoryLimit(64 MiB)`, `setMaxStackSize(1 MiB)`, and an
    interrupt handler with the job's deadline;
  - installs only the globals the job lists, as functions of strings and JSON;
  - evaluates the code and returns `{ ok, result, logs, tests, values }` or `{ error: { code, message, line,
    column } }`.
- `packages/engine/src/script/sandbox/host.ts` (`createScriptSandbox`), after `rest/contract-check-worker-host.ts`:
  - one long-lived worker;
  - one job at a time, with a queue of 16;
  - it terminates and replaces the worker at `deadline + 1000 ms`, and the job's result is then `script-timeout`;
  - a worker that exits unexpectedly is replaced, and the job fails with `script-error`.
- `packages/engine/src/script/sandbox/host-api.ts`: `crypto.hash`, `crypto.hmac`, `crypto.randomUUID`, `encoding.*`,
  and the log, test and value collectors, with the caps from the spec (64 KiB and 1000 lines of log, 1000 tests, 100
  values of 64 KiB).
- `packages/engine/src/script/strip.ts`: `stripTypes(source)`. It calls `module.stripTypeScriptTypes` in `strip`
  mode and silences only that call's `ExperimentalWarning`.
- Test: `packages/engine/test/unit/script/sandbox.test.ts`, `strip.test.ts`.

**Tests**
- `while (true) {}` ends as `script-timeout` within the deadline, and the next job on the same host runs.
- An array grown without bound ends as `script-memory`, and deep recursion ends as `script-error` naming a stack
  overflow.
- `typeof process`, `require`, `fetch`, `setTimeout`, `globalThis.constructor.constructor('return process')()` and
  `import('fs')` are all undefined or throw, and nothing reaches the host.
- `crypto.hmac('sha256', 'k', 'd')` matches Node's result. `log` beyond its caps is cut off with a marker.
- An error's line and column match the source. The stripped output of a fixture is pinned, and stripping keeps
  positions.
- A job's globals do not survive into the next job.

## Task 2 — Engine: the script API and its rules

**Files**
- `packages/engine/src/script/api/`:
  - `common.ts`: `vars`, `props`, `secrets`, `log`, `test` and `expect`, written as JavaScript source that runs
    inside the sandbox over the host functions;
  - `rest.ts`, `soap.ts` and `grpc.ts`: the per-protocol `request` and `response` objects. A pre-request script
    works on a JSON snapshot of the request. The host applies the returned snapshot.
- `packages/engine/src/script/apply.ts`:
  - `applyRequestChanges(protocol, before, after)` checks and applies what a pre-request script changed;
  - a different scheme, host or port (a URL, SOAP endpoint or gRPC target) is `script-origin-change`;
  - CR, LF or NUL in a header, metadata value or SOAPAction is `script-value-invalid`;
  - a typed body is serialised by the engine: JSON for REST, and `applyForm` for the SOAP body.
- `packages/engine/src/script/secrets.ts`:
  - `secretReferencesIn(text)`;
  - after the script, a `${secret:name}` not present before in the request's text is `script-secret-denied`;
  - `secrets.get` is allowed only for names in `scripts.secrets`, and each value read is reported to `onSecretValue`
    before the script runs.
- `packages/engine/src/script/run.ts`: `runPreRequestScript` and `runPostResponseScript`, which return `ScriptOutcome`
  (`tests`, `logs`, `values`, `error?`).
- `packages/engine/src/errors.ts`: `ScriptError`, carrying the spec's codes.
- Tests: `packages/engine/test/unit/script/{api,apply,secrets}.test.ts`.

**Tests**
- A REST pre-request script sets a header, a query parameter and `body.json`, and the applied request has them.
- Changing `url` to another host, to `http:` from `https:`, or to another port is `script-origin-change`, for REST,
  a SOAP endpoint and a gRPC target.
- A header value with `\r\n` is `script-value-invalid`.
- A script that writes `${secret:other}` into a header is `script-secret-denied`. Moving a reference the request
  already had is allowed.
- `secrets.get` for an unlisted name throws `script-secret-denied`, and a listed value is reported for masking.
- `test` records passing and failing tests, and each `expect` matcher passes and fails, with `.not`.
- A `vars.set` value such as `${secret:k}`, `a\r\nb`, `http://evil/` or `</x><y>` is returned verbatim, since
  ADR-0015 applies where the value lands.

## Task 3 — Engine: `formatVersion` 6 and script files

**Files**
- `packages/engine/src/project/model.ts`: `FORMAT_VERSION = 6`, and `ScriptsDef` (`pre?`, `post?`, `api`,
  `enabled`, `secrets`, `timeoutMs`) on SOAP, REST and gRPC request definitions, with the script text loaded.
- `packages/engine/src/project/schema.ts`: a `scripts` key on the three request file schemas, which the WebSocket
  file schema does not accept.
- `packages/engine/src/project/migrate.ts`: 5 → 6 is a stamp.
- `project/load.ts`, `serialize.ts` and `save.ts`:
  - the sidecar files, and the file names derived from the request;
  - `script-file-missing` and `script-too-large` problems;
  - renaming and moving a request move its scripts;
  - a script file is written only when its text changed.
- `apps/desktop/src/main/project-watch.ts`: `isManagedPath` includes `*.pre.ts`, `*.post.ts`, `*.pre.js` and
  `*.post.js` beside a request.
- `docs/adr/0003-project-folder-format.md`: an update for version 6.
- Fixtures: a version-5 project, and a version-6 project with scripts.
- Tests: `packages/engine/test/unit/project/{scripts-format,migrate-6}.test.ts`.

**Tests**
- A version-5 fixture saves with only its `formatVersion` line changed.
- A project with scripts round-trips byte for byte.
- Renaming a request renames `X.pre.ts` to `Y.pre.ts`.
- A missing script file is a problem on the request.
- A WebSocket request with `scripts` is refused.
- An unnamed `.pre.ts` beside a request is left alone and never loaded.

## Task 4 — Engine: types from JSON Schema and proto

**Files**
- `packages/engine/src/script/types/json-schema.ts`: `typeFromJsonSchema(schema, names)`. It follows the spec's
  mapping, uses named aliases for `$ref` and cycles, and widens unknown keywords to `unknown`.
- `packages/engine/src/script/types/rest.ts`: `restScriptTypes(operation | undefined)`. It produces the request body
  type and the response union by status.
- `packages/engine/src/script/types/grpc.ts`: `grpcScriptTypes(protoSet, method)`, built from `describeMessage`,
  with 64-bit values as strings, `bytes` as base64, and `oneof` as a union.
- `packages/engine/src/script/types/api.d.ts.ts`: the static API declarations as a string. The pre and post variants
  share one source.
- Tests: `packages/engine/test/unit/script/types-{json-schema,rest,grpc}.test.ts`, which compare against pinned
  `.d.ts` output and compile it with the checker from Task 5 once that lands.

## Task 5 — Engine: types from XSD, and the XML projection

**Files**
- `packages/engine/src/script/types/xsd.ts`: `soapScriptTypes(schemaSet, operation)`. It follows the spec's element,
  attribute and simple-type mapping, including `"prefix:name"` on a clash and `xs:any` as `unknown`.
- `packages/engine/src/script/xml-projection.ts`:
  - `projectXml(schemaSet, element, xml)` turns an instance into the object the types describe;
  - `applyProjection(schemaSet, element, object)` turns it back into XML in schema order, built on
    `xsd/form-model.ts` (`buildForm` / `applyForm`);
  - mixed content is not projected, and is reported so the SOAP API offers only `envelope` for it.
- Tests: `packages/engine/test/unit/script/{types-xsd,xml-projection}.test.ts`, with the stock-quote and
  order fixtures:
  - a projection round-trip is byte-stable where the instance was already in schema order;
  - a changed field changes only that element;
  - arrays, optional and nillable fields, and attributes are all covered.

## Task 6 — Engine: the checker

**Files**
- `packages/engine/package.json`: `typescript` 5.9, pinned, as a runtime dependency. Licences regenerated.
- `packages/engine/src/script/check/worker.ts` and `host.ts`, one persistent worker:
  - `checkScript({ source, types, api })` returns diagnostics with line, column and message;
  - a language service keeps its models by id for `completionsAt`, `quickInfoAt`, `signatureHelpAt` and
    `diagnostics`;
  - compiler options follow the spec (`strict`, `noEmit`, `erasableSyntaxOnly`, `lib: es2023`, no DOM), with the lib
    files read once.
- `packages/engine/src/script/check/postman.ts`: `parseOnly(source)` for `api: postman`, which reports
  `script-syntax-error`.
- Tests: `packages/engine/test/unit/script/check.test.ts`:
  - `response.json().pett` on a typed response is an error with its position;
  - `response.status === 200 && response.json().id` checks;
  - `enum` is an error;
  - completion at `response.json().` lists the schema's fields.

## Task 7 — Engine: scripts in a send

**Files**
- `packages/engine/src/run/prepare.ts`: two-phase expansion. Properties are expanded before the script, and
  `${secret:…}` after it. The SOAP path hands the script the expanded envelope before auth, WS-Addressing and
  WS-Security. A new hook in `packages/engine/src/send.ts` runs after `expandSendInput` and before `applySoapAuth`.
- `packages/engine/src/run/run.ts`, in `createRunSender`:
  1. type-check once per request, cached by script hash and type hash;
  2. run the pre-request script;
  3. apply its changes;
  4. send;
  5. run the post-response script against the subject;
  6. merge its tests into the assertions as type `script`;
  7. hand its values to the run's value scope;
  8. return `scriptLog` and `scriptsOff`.
- `RequestResult` gains optional `scriptLog` and `scriptsOff`. `AssertionResult` gains type `script`.
- `packages/engine/src/run/run.ts`, in `runRequests`: one value scope shared across the run, in order. The run
  applies it as `RunContext.sequence`.
- `enabled: false`: no check and no run, and `scriptsOff: true`.
- Tests: `packages/engine/test/unit/run/scripts.test.ts`, against a local server:
  - log in, then a script sets the token, then the next request uses it;
  - an HMAC signature header from a listed secret is masked in the result;
  - a type error fails before any send;
  - a pre-request error means no send;
  - a SOAP body change is signed by WS-Security, because it runs before WSS;
  - `enabled: false`.

## Task 8 — CLI

**Files**
- `packages/cli/src/commands/run.ts` and `sequence.ts`:
  - check every enabled script of the selection first;
  - on errors, write each file, line and message to stderr and exit 2;
  - `--verbose` prints script logs.
- The cli, html, json and junit reporters show `script` assertions, and the JSON reporter carries `scriptLog`,
  masked.
- `docs/cli.md`: a Scripts section.
- Tests: `packages/cli/test/integration/scripts.test.ts`. The demo server's `/login` and `/carts` routes are reused,
  with a signed-request route added.

## Task 9 — Postman

**Files**
- `packages/engine/src/rest/postman/parse.ts` and `map.ts`:
  - read `event` scripts at the collection, folder and request levels;
  - concatenate them per request with part markers;
  - write `.pre.js` and `.post.js` with `api: postman` and `enabled: false`;
  - the summary counts requests with scripts, and lists the unsupported calls from a static scan.
- `packages/engine/src/script/api/postman.ts`: the `pm` layer, written as JavaScript that runs inside the sandbox over
  the common API:
  - `pm.test`;
  - an `expect` chain subset;
  - `pm.response`, `pm.request` and `pm.info`;
  - variable get and set mapped to `vars` and `props`;
  - `CryptoJS`, `btoa` and `atob`;
  - `script-unsupported` stubs for everything else the spec names.
- Tests: `packages/engine/test/unit/rest/postman-scripts.test.ts` and
  `packages/engine/test/unit/script/postman-layer.test.ts`:
  - a fixture collection with root, folder and request scripts, concatenated in order;
  - `enabled: false`;
  - the layer runs typical test scripts;
  - `pm.sendRequest` is `script-unsupported`.

## Task 10 — Desktop main

**Files**
- `apps/desktop/src/main/ipc/request.ts`: the SOAP, REST and gRPC send paths run the scripts through the engine's
  helpers from Task 7.
  - The pre-request script runs after `restSend`/`grpcSend` resolve, and before OAuth2 and TLS.
  - SOAP goes through the `send.ts` hook.
  - The post-response script runs from `EngineService.observe`, before the History entry and log row are built, so
    secrets read by a script are masked in both.
- `apps/desktop/src/main/session-values.ts`: per project, in memory:
  - `set`, `get`, `list` and `clear`;
  - it feeds single sends as `RunContext.sequence`;
  - the sequence runner still uses its own run scope.
- `apps/desktop/src/main/script-service.ts`: the checker host from Task 6.
  - It builds types per request from `openApiDocumentFor`, `schemaSetFor` and `grpcProtoSetFor`.
  - It caches them, and invalidates them on Update Definition.
- IPC:
  - `script.diagnostics`, `script.completions`, `script.quickInfo`, `script.signatureHelp`;
  - `script.values.list`, `script.values.clear`, and the `script.values.changed` event;
  - mutations `update-request-scripts` (text, enabled, secrets, timeout) and `enable-scripts` (bulk), validated by the
    engine schema.
- Wire types in `apps/desktop/src/shared/wire-types.ts`.
- `apps/desktop/electron-builder.yml`: `asarUnpack` for the QuickJS WASM file, only if loading it from the asar fails
  in the packaged smoke test.
- Tests:
  - `apps/desktop/test/{script-send,session-values,script-mutations}.test.ts`;
  - `script-send` covers the ordering, masking in History and the log, `script-origin-change`, and `scriptsOff`.

## Task 11 — Renderer

**Files**
- `apps/desktop/src/renderer/editor/monaco-core.ts`: register the `typescript` and `javascript` basic-language
  definitions (Monarch only).
- `apps/desktop/src/renderer/editor/script-language.ts`: completion, hover, signature help and marker providers that
  call the IPC from Task 10, keyed by model URI, like `json-completion.ts`.
- `apps/desktop/src/renderer/features/scripts/`:
  - `scripts-tab.tsx`, with pre and post editors, a secrets list, a timeout, and the off banner with **Switch on**;
  - `enable-scripts-dialog.tsx`;
  - `script-results.tsx`, the response **Script** tab.
- The SOAP, REST and gRPC request editors get the **Scripts** tab, with a dot when scripts are set.
- The explorer gets a **Values** node with **Clear**, and **Switch on scripts…** on an API or folder.
- Commands: `script.clearValues`. Regenerate `docs-site` `reference/commands.md`.
- Tests:
  - `apps/desktop/test/renderer/{scripts-tab,script-language,enable-scripts-dialog}.test.tsx`;
  - `build-output.test.ts` must still pass unchanged, with no `ts.worker` and under budget.

## Task 12 — e2e, docs and changelog

- `e2e/specs/scripts.spec.ts`:
  - a log-in request's post-response script sets `token` as secret, and the next single send uses
    `${#Sequence#token}` and passes, with the token shown only masked;
  - a type error in a pre-request script shows in the editor and blocks the send.
- Docs:
  - `docs-site/src/content/docs/guides/scripts.mdx`, with a sidebar entry;
  - a `reference/script-api.md` generated from the API declarations, with a `--check` in `pnpm check`;
  - `reference/project-format.md` (version 6);
  - `reference/property-syntax.mdx` (session values);
  - `guides/sequences.mdx` (a single send's values);
  - `switching/postman.mdx` (scripts row);
  - `docs/security.md` ("A script runs with no capabilities");
  - `docs/success-criteria.md` SC-S1 onwards;
  - `docs/roadmap.md` item 13;
  - `CHANGELOG.md`.
- `pnpm check`, then `pnpm build && xvfb-run -a pnpm test:e2e -- scripts.spec.ts`.
